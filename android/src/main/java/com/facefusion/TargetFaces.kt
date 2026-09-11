package com.facefusion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import com.facefusion.mobile.NativePipe

/**
 * Detects every face in a *target* — a photo, or the first frame of a video — so a UI can
 * let the user pick which one gets swapped, instead of every face found (or just the
 * largest, via [SwapConfig.largestFaceOnly]). Pass the chosen box back as
 * `targetFaceBox`; [PhotoSwap]/[VideoSwap] crop to it with [FaceCrop] the same way
 * [SourceFaces] crops for `setSource`, so this needed no native change either.
 *
 * Structurally a twin of [SourceFaces.detect] — duplicated rather than shared, same as
 * [VideoSwap]'s own note on why it doesn't share code with [PhotoSwap]: each is a small,
 * self-contained entry point, and the one real difference (this one also has to handle a
 * video target) doesn't belong in the source-only file.
 */
object TargetFaces {

  /** Mirrors [PhotoSwap.ModelsMissing] — same required models a swap needs. */
  class ModelsMissing(message: String) : Exception(message)

  fun detect(context: Context, targetPath: String, cfg: SwapConfig): List<DetectedFace> {
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

    val bitmap = decode(targetPath)
    return PipeGuard.run(context, tier, cfg) {
      val bgr = NativePipe.argbToBgr(pixelsOf(bitmap), bitmap.width, bitmap.height)
      val flat = NativePipe.analyseFaces(bgr, bitmap.width, bitmap.height)
        ?: throw IllegalStateException(NativePipe.lastError())
      (flat.indices step 5).map { i ->
        DetectedFace(
          flat[i],
          flat[i + 1],
          flat[i + 2],
          flat[i + 3],
          flat[i + 4],
          bitmap.width,
          bitmap.height,
        )
      }
    }
  }

  /** A photo decodes directly; a video falls back to its first frame, already rotated
   *  upright by [MediaMetadataRetriever] itself — the same orientation [VideoSwap]'s own
   *  loop presents to `processFrame`, which is what makes a box detected here line up with
   *  what that loop sees per frame, with no rotation math needed on this side at all. */
  private fun decode(path: String): Bitmap {
    // Capped at [BitmapDecode.TARGET_MAX] -- the same cap [PhotoSwap] decodes a photo
    // target with, which is what keeps a box picked here aligned with what the swap
    // actually crops. `decodeOrNull`, not `decode`, because "not a still image" is how the
    // video branch below is reached.
    BitmapDecode.decodeOrNull(path, BitmapDecode.TARGET_MAX)?.let { return it }

    // A video frame arrives at the clip's own resolution, uncapped -- and deliberately so:
    // VideoSwap's loop processes frames at that resolution too, so capping here would
    // misalign every box against the frames the swap actually sees. Codec limits keep this
    // bounded in practice where a photo's megapixels are not.
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(path)
      return retriever.frameAtTime
        ?: throw IllegalArgumentException("Could not decode image or video frame: $path")
    } finally {
      retriever.release()
    }
  }

  private fun pixelsOf(bitmap: Bitmap): IntArray {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return pixels
  }
}
