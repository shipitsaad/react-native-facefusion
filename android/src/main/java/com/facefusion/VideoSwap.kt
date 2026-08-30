package com.facefusion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import com.facefusion.mobile.NativePipe
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer

/** A tick of progress through [VideoSwap.run]. */
data class VideoSwapProgress(
  /** Frames decoded, swapped and encoded so far. */
  val frameIndex: Int,
  /** Estimated from the container's duration and frame rate — not exact, since a
   *  variable-frame-rate source has no true count until the last frame arrives. `0` when
   *  it could not be estimated. */
  val estimatedFrameCount: Int,
  /** Wall-clock frames/second across the loop so far, not upstream's per-graph figure. */
  val fps: Double,
)

/** The result of one video swap. */
data class VideoSwapResult(
  val outputPath: String,
  /** Frames decoded, swapped and encoded — the real count, unlike [VideoSwapProgress]'s
   *  estimate. */
  val frameCount: Int,
  /** Of [frameCount], how many had at least one face swapped. */
  val faceFrameCount: Int,
  /** The tier that ran — see [ModelPaths.tier]. */
  val tier: String,
  /** Wall-clock frames/second across the decode-swap-encode loop only: excludes opening
   *  the extractor/codecs and the final mux/audio-copy pass. Measured, per rule 11 — never
   *  reported as upstream's per-graph figure, which this is not. */
  val fps: Double,
  /** Whether the source clip had an audio track, which — if true — was copied to
   *  [outputPath] unmodified. */
  val hasAudio: Boolean,
)

/**
 * Swaps a face from [VideoSwap.run]'s `sourcePath` into every frame of a video, writing the
 * result to `outputPath`.
 *
 * Shaped like [PhotoSwap]: paths in, path out, and this is the only other place in the
 * Kotlin layer that touches pixels. What's different from a still is everything about
 * getting pixels in and out of [NativePipe] — MediaExtractor → MediaCodec(decode) →
 * [NativePipe.processFrame] → MediaCodec(encode) → MediaMuxer, all synchronous on the
 * caller's thread, one frame at a time. The three converters this needed —
 * [NativePipe.yuvToBgr], [NativePipe.rotateBgr], [NativePipe.bgrToImagePlanes] — were
 * already exported by upstream's vendored, unmodified `ffjni.cpp` (ADR-0004): nothing here
 * changes the C++, only wires symbols that were sitting unused since Phase 3.
 *
 * **Two passes, not one interleaved stream.** The whole video track is decoded, swapped and
 * encoded first, buffering the (small — a few MB for a short clip) encoded output in memory;
 * only then is the muxer opened, because the muxer needs the encoder's *actual* output
 * `MediaFormat` (only known once the encoder starts producing) before any track can be
 * added, and needs every track added before `start()`. Interleaving a live audio copy with
 * that would mean holding audio samples until the video format shows up. Buffering encoded
 * video instead is simpler and correct for the clip lengths this project targets; a
 * multi-minute clip would want a streaming interleave instead — not needed yet.
 */
object VideoSwap {

  /** Mirrors [PhotoSwap.ModelsMissing] — the tier's required models are not on disk. */
  class ModelsMissing(message: String) : Exception(message)

  /** Thrown when [cancel] was called mid-run. The partial [outputPath] is deleted first. */
  class Cancelled : IOException("Cancelled")

  private const val TIMEOUT_US = 10_000L
  // Bounds the busy-wait for a free codec input buffer. At 10 ms per poll this is 5 s,
  // generous for a codec that is merely busy and a hard stop for one that is stuck --
  // without a bound, a stalled codec would hang the job past where [cancel] can reach it,
  // since the check for it lives in this same wait.
  private const val MAX_STALL_POLLS = 500

  @Volatile
  private var cancelled = false

  /** Asks the run in flight to stop. Idempotent, and safe to call when nothing is running. */
  fun cancel() {
    cancelled = true
  }

  fun run(
    context: Context,
    sourcePath: String,
    targetPath: String,
    outputPath: String,
    cfg: SwapConfig,
    /** `[left, top, right, bottom]` from [SourceFaces.detect], or `null` for the default
     *  "largest face in the source" that [NativePipe.setSource] already picks on its own. */
    sourceFaceBox: FloatArray? = null,
    /** `[left, top, right, bottom]` from [TargetFaces.detect], in the clip's upright
     *  (post-rotation-correction) coordinate space, or `null` to swap every face found in
     *  every frame, same as before this option existed. Picked once and held fixed for the
     *  whole clip — Saad's own call: re-detecting the face every frame to track it as it
     *  moves would cost a full extra detector pass per frame, on an already-slow NPU
     *  pipeline, for a demo app where a locked crop is the right tradeoff. See [FaceCrop]. */
    targetFaceBox: FloatArray? = null,
    /** Caps how many of the source's frames actually get swapped and encoded — the rest are
     *  decoded and dropped. `null` or `>=` the source's own frame rate processes every
     *  frame, unchanged from before this option existed. Trades output smoothness for wall-
     *  clock swap time: half the frames is roughly half the NPU + encode work. */
    targetFps: Int? = null,
    onProgress: (VideoSwapProgress) -> Unit,
  ): VideoSwapResult {
    cancelled = false

    NativePipe.loadError?.let {
      throw IllegalStateException("libffnative.so did not load: $it")
    }

    val tier = ModelPaths.tier(context)
    val missing = ModelPaths.missing(context, tier)
    if (missing.isNotEmpty()) {
      throw ModelsMissing(
        "Models missing for $tier: ${missing.joinToString(", ")} — call downloadModels() first"
      )
    }

    try {
      return PipeGuard.run(context, tier, cfg) {
        val decodedSource = decodeBitmap(sourcePath)
        val source = sourceFaceBox?.let { SourceFaces.cropToFace(decodedSource, it) } ?: decodedSource
        val sourceBgr = NativePipe.argbToBgr(pixelsOf(source), source.width, source.height)
        if (!NativePipe.setSource(sourceBgr, source.width, source.height)) {
          throw IllegalStateException(NativePipe.lastError())
        }
        encode(targetPath, outputPath, tier, targetFaceBox, targetFps, onProgress)
      }
    } catch (e: Cancelled) {
      File(outputPath).delete()
      throw e
    }
  }

  private fun encode(
    targetPath: String,
    outputPath: String,
    tier: String,
    targetFaceBox: FloatArray?,
    targetFps: Int?,
    onProgress: (VideoSwapProgress) -> Unit,
  ): VideoSwapResult {
    val probe = MediaExtractor().apply { setDataSource(targetPath) }
    val videoTrack = findTrack(probe, "video/")
      ?: throw IllegalArgumentException("No video track in $targetPath")
    val videoFormat = probe.getTrackFormat(videoTrack)
    val mime = videoFormat.getString(MediaFormat.KEY_MIME)
      ?: throw IllegalArgumentException("Video track has no MIME type")
    val width = videoFormat.getInteger(MediaFormat.KEY_WIDTH)
    val height = videoFormat.getInteger(MediaFormat.KEY_HEIGHT)
    // MediaCodec never applies this -- it is a container flag a player honours and a
    // decoder does not, so a portrait clip decodes as sideways landscape frames. Corrected
    // per frame below with rotateBgr, then restored on the output track with the same hint.
    val rotation = if (videoFormat.containsKey(MediaFormat.KEY_ROTATION)) {
      videoFormat.getInteger(MediaFormat.KEY_ROTATION)
    } else 0
    // Some encoders stored this as a float, not the documented int -- runCatching rather
    // than a crash over a number that only ever feeds a progress estimate and the output
    // bitrate heuristic below.
    val frameRate = runCatching {
      if (videoFormat.containsKey(MediaFormat.KEY_FRAME_RATE)) {
        videoFormat.getInteger(MediaFormat.KEY_FRAME_RATE).coerceAtLeast(1)
      } else 30
    }.getOrDefault(30)
    // `targetFps` only drops frames, never adds them -- out of range (<=0, or >= the
    // source's own rate) means "every frame", the behaviour before this option existed.
    val effectiveFps = targetFps?.takeIf { it in 1 until frameRate } ?: frameRate
    val estimatedFrameCount = if (videoFormat.containsKey(MediaFormat.KEY_DURATION)) {
      ((videoFormat.getLong(MediaFormat.KEY_DURATION) / 1_000_000.0) * effectiveFps)
        .toInt().coerceAtLeast(0)
    } else 0
    val audioTrack = findTrack(probe, "audio/")
    val audioFormat = audioTrack?.let { probe.getTrackFormat(it) }
    probe.release()

    // Fixed for the whole clip -- rotation doesn't change frame to frame, so neither does
    // the upright size processFrame sees, which is what a target-face crop rect is in.
    val (uprightW, uprightH) = if (rotation == 90 || rotation == 270) height to width else width to height
    val targetRect = targetFaceBox?.let { FaceCrop.rect(it, uprightW, uprightH) }

    val extractor = MediaExtractor().apply { setDataSource(targetPath) }
    extractor.selectTrack(videoTrack)

    val decoder = MediaCodec.createDecoderByType(mime)
    decoder.configure(videoFormat, null, null, 0)
    decoder.start()

    val encFormat = MediaFormat.createVideoFormat(mime, width, height).apply {
      setInteger(
        MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible
      )
      // A simple bits-per-pixel heuristic (~4x the pixel count) rather than a fixed number:
      // it scales with resolution instead of being tuned for 720p alone and silently wrong
      // elsewhere. Floored so a tiny/low-fps clip doesn't get an unusably low bitrate.
      setInteger(MediaFormat.KEY_BIT_RATE, (width * height * 4).coerceAtLeast(2_000_000))
      setInteger(MediaFormat.KEY_FRAME_RATE, frameRate)
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
    }
    val encoder = MediaCodec.createEncoderByType(mime)
    encoder.configure(encFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    encoder.start()

    val encodedChunks = mutableListOf<Pair<ByteArray, MediaCodec.BufferInfo>>()
    var outputFormat: MediaFormat? = null
    var inputDone = false
    var frameIndex = 0
    var faceFrameCount = 0
    // Bresenham-style frame-rate reduction: keeps whichever decoded frames land closest to
    // an even spread at `effectiveFps`, rather than a fixed "every Nth" stride that would
    // drift against a variable-frame-rate source.
    var decodedCount = 0
    var keptCount = 0
    val info = MediaCodec.BufferInfo()
    val loopStart = System.nanoTime()
    // One sample per second of PRESENTATION time, not per decoded frame -- matches
    // upstream's own video sampling rate for the content gate (docs/02-upstream.md).
    val contentSampler = ContentGate.VideoSampler()
    var lastSampledSecond = -1

    try {
      var encoderDone = false
      while (!encoderDone) {
        throwIfCancelled()

        if (!inputDone) {
          val inIndex = decoder.dequeueInputBuffer(TIMEOUT_US)
          if (inIndex >= 0) {
            val buf = decoder.getInputBuffer(inIndex)!!
            val sampleSize = extractor.readSampleData(buf, 0)
            if (sampleSize < 0) {
              decoder.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              decoder.queueInputBuffer(inIndex, 0, sampleSize, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        var draining = true
        while (draining) {
          val outIndex = decoder.dequeueOutputBuffer(info, TIMEOUT_US)
          if (outIndex < 0) {
            draining = false
            continue
          }
          if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
            decoder.releaseOutputBuffer(outIndex, false)
            feedEncoderEos(encoder)
            draining = false
            continue
          }
          if (info.size <= 0) {
            decoder.releaseOutputBuffer(outIndex, false)
            continue
          }

          decodedCount++
          val keep = effectiveFps >= frameRate || (decodedCount * effectiveFps) / frameRate > keptCount
          if (!keep) {
            // Dropped before ever touching an Image or the NPU -- this is the entire saving
            // targetFps buys: no processFrame call, no encode, just hand the buffer back.
            decoder.releaseOutputBuffer(outIndex, false)
            continue
          }
          keptCount++

          val image = decoder.getOutputImage(outIndex)
            ?: throw IllegalStateException("Decoder did not return a YUV image for $targetPath")
          var bgr = bgrFromImage(image, width, height)
          image.close()
          decoder.releaseOutputBuffer(outIndex, false)

          // Content-gate sample, on the raw (pre-rotation-correction) frame -- orientation
          // does not matter for this check, and it's the same bytes already in hand.
          val presentedSecond = (info.presentationTimeUs / 1_000_000L).toInt()
          if (presentedSecond != lastSampledSecond) {
            lastSampledSecond = presentedSecond
            contentSampler.sample(bgr, width, height)
          }

          val (fw, fh) = if (rotation == 90 || rotation == 270) height to width else width to height
          if (rotation != 0) {
            bgr = NativePipe.rotateBgr(bgr, width, height, rotation)
              ?: throw IllegalStateException(NativePipe.lastError())
          }
          val faces = if (targetRect != null) {
            // Same crop-swap-paste trick PhotoSwap uses: processFrame only ever sees the
            // chosen face's region, so it can't touch anything outside it.
            val cropped = FaceCrop.crop(bgr, fw, targetRect)
            val cw = targetRect[2] - targetRect[0]
            val ch = targetRect[3] - targetRect[1]
            val count = NativePipe.processFrame(cropped, cw, ch)
            if (count > 0) FaceCrop.paste(bgr, fw, cropped, targetRect)
            count
          } else {
            NativePipe.processFrame(bgr, fw, fh)
          }
          if (faces < 0) throw IllegalStateException(NativePipe.lastError())
          if (faces > 0) faceFrameCount++
          if (rotation != 0) {
            bgr = NativePipe.rotateBgr(bgr, fw, fh, (360 - rotation) % 360)
              ?: throw IllegalStateException(NativePipe.lastError())
          }
          // Same orientation the encoder is about to receive, so the preview matches the
          // output file rather than the decoder's raw (possibly sideways) frame.
          PreviewSurfaceHolder.draw(bgr, width, height)
          feedEncoderFrame(encoder, bgr, width, height, info.presentationTimeUs)

          frameIndex++
          val elapsedS = (System.nanoTime() - loopStart) / 1_000_000_000.0
          onProgress(
            VideoSwapProgress(frameIndex, estimatedFrameCount, if (elapsedS > 0) frameIndex / elapsedS else 0.0)
          )
        }

        var encoderDraining = true
        while (encoderDraining) {
          val outIndex = encoder.dequeueOutputBuffer(info, TIMEOUT_US)
          when {
            outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> outputFormat = encoder.outputFormat
            outIndex < 0 -> encoderDraining = false
            else -> {
              if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG == 0 && info.size > 0) {
                val buf = encoder.getOutputBuffer(outIndex)!!
                buf.position(info.offset)
                buf.limit(info.offset + info.size)
                val chunk = ByteArray(info.size)
                buf.get(chunk)
                val chunkInfo = MediaCodec.BufferInfo()
                  .apply { set(0, chunk.size, info.presentationTimeUs, info.flags) }
                encodedChunks += chunk to chunkInfo
              }
              val isEos = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
              encoder.releaseOutputBuffer(outIndex, false)
              if (isEos) {
                encoderDone = true
                encoderDraining = false
              }
            }
          }
        }
      }
    } finally {
      decoder.stop()
      decoder.release()
      encoder.stop()
      encoder.release()
      extractor.release()
    }

    // Applied here, before the muxer ever opens outputPath -- a refusal must never leave a
    // partial or full file behind, the same "refuse before doing the work" shape as the
    // single-frame check in PhotoSwap.
    contentSampler.finish()

    val elapsedS = (System.nanoTime() - loopStart) / 1_000_000_000.0
    val fps = if (elapsedS > 0) frameIndex / elapsedS else 0.0

    mux(outputPath, rotation, outputFormat, encodedChunks, targetPath, audioTrack, audioFormat)

    return VideoSwapResult(outputPath, frameIndex, faceFrameCount, tier, fps, audioFormat != null)
  }

  private fun mux(
    outputPath: String,
    rotation: Int,
    videoFormat: MediaFormat?,
    encodedChunks: List<Pair<ByteArray, MediaCodec.BufferInfo>>,
    targetPath: String,
    audioTrack: Int?,
    audioFormat: MediaFormat?,
  ) {
    val format = videoFormat
      ?: throw IllegalStateException("Encoder never reported an output format")
    File(outputPath).parentFile?.mkdirs()
    val muxer = MediaMuxer(outputPath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    try {
      if (rotation != 0) muxer.setOrientationHint(rotation)
      val videoMuxTrack = muxer.addTrack(format)
      val audioMuxTrack = if (audioFormat != null) muxer.addTrack(audioFormat) else -1
      muxer.start()

      for ((bytes, chunkInfo) in encodedChunks) {
        muxer.writeSampleData(videoMuxTrack, ByteBuffer.wrap(bytes), chunkInfo)
      }

      if (audioMuxTrack >= 0 && audioTrack != null) {
        copyAudio(targetPath, audioTrack, muxer, audioMuxTrack)
      }
    } finally {
      muxer.stop()
      muxer.release()
    }
  }

  /** Raw compressed-sample copy — no decode, no encode, since only video pixels change. */
  private fun copyAudio(targetPath: String, audioTrack: Int, muxer: MediaMuxer, muxTrack: Int) {
    val extractor = MediaExtractor().apply { setDataSource(targetPath) }
    try {
      extractor.selectTrack(audioTrack)
      val buf = ByteBuffer.allocateDirect(1 shl 20)
      val info = MediaCodec.BufferInfo()
      while (true) {
        throwIfCancelled()
        buf.clear()
        val size = extractor.readSampleData(buf, 0)
        if (size < 0) break
        info.set(0, size, extractor.sampleTime, extractor.sampleFlags)
        muxer.writeSampleData(muxTrack, buf, info)
        extractor.advance()
      }
    } finally {
      extractor.release()
    }
  }

  private fun feedEncoderFrame(encoder: MediaCodec, bgr: ByteArray, w: Int, h: Int, ptsUs: Long) {
    val index = dequeueInputBufferBlocking(encoder)
    val image = encoder.getInputImage(index)
      ?: throw IllegalStateException("Encoder does not support Image-based input")
    val planes = image.planes
    val ok = NativePipe.bgrToImagePlanes(
      bgr, w, h,
      planes[0].buffer, planes[0].rowStride, planes[0].pixelStride,
      planes[1].buffer, planes[1].rowStride, planes[1].pixelStride,
      planes[2].buffer, planes[2].rowStride, planes[2].pixelStride,
    )
    image.close()
    if (!ok) throw IllegalStateException(NativePipe.lastError())
    encoder.queueInputBuffer(index, 0, w * h * 3 / 2, ptsUs, 0)
  }

  private fun feedEncoderEos(encoder: MediaCodec) {
    val index = dequeueInputBufferBlocking(encoder)
    encoder.queueInputBuffer(index, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
  }

  private fun dequeueInputBufferBlocking(encoder: MediaCodec): Int {
    repeat(MAX_STALL_POLLS) {
      throwIfCancelled()
      val index = encoder.dequeueInputBuffer(TIMEOUT_US)
      if (index >= 0) return index
    }
    throw IllegalStateException("Encoder did not free an input buffer in time")
  }

  private fun bgrFromImage(image: Image, w: Int, h: Int): ByteArray {
    val planes = image.planes
    return NativePipe.yuvToBgr(
      planeBytes(planes[0].buffer), planes[0].rowStride,
      planeBytes(planes[1].buffer), planes[1].rowStride, planes[1].pixelStride,
      planeBytes(planes[2].buffer), planes[2].rowStride, planes[2].pixelStride,
      w, h,
    )
  }

  private fun planeBytes(buffer: ByteBuffer): ByteArray {
    val dup = buffer.duplicate()
    val bytes = ByteArray(dup.remaining())
    dup.get(bytes)
    return bytes
  }

  private fun findTrack(extractor: MediaExtractor, mimePrefix: String): Int? {
    for (i in 0 until extractor.trackCount) {
      val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME) ?: continue
      if (mime.startsWith(mimePrefix)) return i
    }
    return null
  }

  private fun throwIfCancelled() {
    if (cancelled) throw Cancelled()
  }

  // Duplicated from PhotoSwap rather than shared: each swap object is self-contained, the
  // same shape upstream's own files are in, and this is ten lines.
  private fun decodeBitmap(path: String): Bitmap {
    val options = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
    return BitmapFactory.decodeFile(path, options)
      ?: throw IllegalArgumentException("Could not decode image: $path")
  }

  private fun pixelsOf(bitmap: Bitmap): IntArray {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return pixels
  }
}
