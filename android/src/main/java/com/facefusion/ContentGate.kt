package com.facefusion

import com.facefusion.mobile.NativePipe

/**
 * Upstream's NSFW content gate (ADR-0003), run on the public API path where a JS caller
 * cannot skip it -- no `skipCheck` option exists anywhere above [PhotoSwap]/[VideoSwap].
 *
 * **This is the one file a personal, gate-free build deletes.** `android/build.gradle`
 * generates a no-op stand-in with this class's public surface when the file is absent, so
 * deleting it is the only change needed -- [PhotoSwap]/[VideoSwap] call [ContentGate]
 * exactly the same way either build compiles it. That build renames itself `-dev` with a
 * distinct `applicationId` (see `example/android/app/build.gradle`), upstream's own switch,
 * not a bypass flag.
 *
 * Gates on `nsfw_2` alone, not upstream's 2-of-3 vote across three models -- 461 MB was not
 * worth it against a 266 MB app (`docs/roadmap.md` 2) -- and the quantised build every tier
 * but v79 uses sits ~0.087 mean closer to flagging. Both limits belong in the README, not
 * hidden, per ADR-0003.
 */
object ContentGate {

  /** Refused. [isQuantised] lets a caller mention the known quantisation bias in its own
   *  message without this class importing any UI concern. */
  class Refused(message: String, val isQuantised: Boolean) : Exception(message)

  // content_analyser.py:detect_with_nsfw_2 -- logit[0] - logit[1] > 0.25 flags a frame.
  private const val THRESHOLD = 0.25f

  // Refuse a video only on the AGGREGATE rate across its sampled frames, not on the first
  // flagged one -- a single false positive should not sink an otherwise-clean clip.
  private const val VIDEO_FLAG_RATE = 0.10

  /**
   * One frame -- a still photo. Call with the TARGET frame, the content actually being
   * processed, before [NativePipe.processFrame] runs: refusing up front skips the swap
   * entirely instead of doing the work and then discarding it.
   */
  fun checkFrame(bgr: ByteArray, w: Int, h: Int) {
    val quantised = NativePipe.contentGateIsQuantised()
    val score = NativePipe.contentScore(bgr, w, h)
    // A failure to measure is treated as an error, never as "allow" (docs/02-upstream.md).
    if (score.isNaN()) {
      throw Refused("Content check failed: ${NativePipe.lastError()}", quantised)
    }
    if (score > THRESHOLD) {
      throw Refused("Content check flagged this image (score %.2f)".format(score), quantised)
    }
  }

  /**
   * Accumulates one sampled frame per second of a video target. [VideoSwap] already decodes
   * every frame for the swap itself and buffers every encoded frame until the whole clip is
   * done before muxing -- so [sample] rides that same loop for free, and [finish] applies the
   * rate rule before the muxer (and thus [outputPath]) is ever touched, exactly like refusing
   * a still up front.
   */
  class VideoSampler {
    private var sampled = 0
    private var flagged = 0
    private var quantised = false

    fun sample(bgr: ByteArray, w: Int, h: Int) {
      quantised = NativePipe.contentGateIsQuantised()
      val score = NativePipe.contentScore(bgr, w, h)
      if (score.isNaN()) {
        throw Refused("Content check failed: ${NativePipe.lastError()}", quantised)
      }
      sampled++
      if (score > THRESHOLD) flagged++
    }

    /** Call once, after every frame has been offered to [sample]. A clip too short to have
     *  sampled anything is not refused -- there is nothing measured to refuse it on. */
    fun finish() {
      if (sampled == 0) return
      val rate = flagged.toDouble() / sampled
      if (rate > VIDEO_FLAG_RATE) {
        throw Refused(
          "Content check flagged ${(rate * 100).toInt()}% of sampled frames (limit 10%)",
          quantised,
        )
      }
    }
  }
}
