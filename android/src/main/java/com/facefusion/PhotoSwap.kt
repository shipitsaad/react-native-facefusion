package com.facefusion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.facefusion.mobile.NativePipe
import java.io.File
import java.io.FileOutputStream

/** The result of one still-photo swap. */
data class PhotoSwapResult(
  val outputPath: String,
  /** Faces found in the target, per [NativePipe.processFrame]. `0` means the swap ran but
   *  found nothing to swap — [outputPath] is then an untouched copy of the target. */
  val faceCount: Int,
  /** The tier that ran, from [ModelPaths.tier] — see that file for why it, not the chip's
   *  raw probe, is the one that matters here. */
  val tier: String,
)

/**
 * Swaps a face from [sourcePath] into every face found in [targetPath], writing the result
 * to [outputPath].
 *
 * Paths in, path out (`docs/01-architecture.md`) — this is the only place in the Kotlin
 * layer that touches pixels, and it does so only to get them into and out of [NativePipe]'s
 * flat BGR arrays. Everything between is native.
 */
object PhotoSwap {

  /** The tier's required models are not on disk. Distinct from a native/runtime failure so
   *  the TurboModule can give it its own rejection code — see [FacefusionModule.swapPhoto]. */
  class ModelsMissing(message: String) : Exception(message)

  fun run(
    context: Context,
    sourcePath: String,
    targetPath: String,
    outputPath: String,
    cfg: SwapConfig,
    /** `[left, top, right, bottom]` from [SourceFaces.detect], or `null` for the default
     *  "largest face in the source" that [NativePipe.setSource] already picks on its own. */
    sourceFaceBox: FloatArray? = null,
  ): PhotoSwapResult {
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

    val decodedSource = decode(sourcePath)
    val source = sourceFaceBox?.let { SourceFaces.cropToFace(decodedSource, it) } ?: decodedSource
    val target = decode(targetPath)

    return PipeGuard.run(context, tier, cfg) {
      val sourceBgr = NativePipe.argbToBgr(pixelsOf(source), source.width, source.height)
      if (!NativePipe.setSource(sourceBgr, source.width, source.height)) {
        throw IllegalStateException(NativePipe.lastError())
      }

      val targetBgr = NativePipe.argbToBgr(pixelsOf(target), target.width, target.height)
      ContentGate.checkFrame(targetBgr, target.width, target.height)
      val faceCount = NativePipe.processFrame(targetBgr, target.width, target.height)
      if (faceCount < 0) throw IllegalStateException(NativePipe.lastError())

      // One frame, not a loop -- shows the result on any mounted <FacefusionPreview />
      // immediately, before the encode-to-file below even starts.
      PreviewSurfaceHolder.draw(targetBgr, target.width, target.height)

      val outArgb = NativePipe.bgrToArgb(targetBgr, target.width, target.height, target.width, target.height)
      val outBitmap = Bitmap.createBitmap(target.width, target.height, Bitmap.Config.ARGB_8888)
      outBitmap.setPixels(outArgb, 0, target.width, 0, 0, target.width, target.height)
      write(outBitmap, outputPath)

      PhotoSwapResult(outputPath, faceCount, tier)
    }
  }

  // ARGB_8888 forced explicitly: BitmapFactory defaults to software ARGB_8888 for
  // decodeFile already, but leaving it implicit invites a HARDWARE bitmap the moment
  // someone "helpfully" switches this to ImageDecoder later -- getPixels() throws on that.
  private fun decode(path: String): Bitmap {
    val options = BitmapFactory.Options().apply { inPreferredConfig = Bitmap.Config.ARGB_8888 }
    return BitmapFactory.decodeFile(path, options)
      ?: throw IllegalArgumentException("Could not decode image: $path")
  }

  private fun pixelsOf(bitmap: Bitmap): IntArray {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return pixels
  }

  private fun write(bitmap: Bitmap, path: String) {
    val file = File(path)
    file.parentFile?.mkdirs()
    FileOutputStream(file).use { out ->
      val format = if (path.endsWith(".png", ignoreCase = true)) {
        Bitmap.CompressFormat.PNG
      } else {
        Bitmap.CompressFormat.JPEG
      }
      bitmap.compress(format, 92, out)
    }
  }
}
