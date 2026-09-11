package com.facefusion

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.facefusion.mobile.NativePipe

/**
 * One face found in an image.
 *
 * The box is in the pixel coordinates of **the bitmap that was actually analysed**, which
 * is not the file on disk: a source photo is decoded capped at [BitmapDecode.SOURCE_MAX],
 * a photo target at [BitmapDecode.TARGET_MAX], and a video target not capped at all (its
 * own frame size). That is deliberate — it is the same space [PhotoSwap]/[VideoSwap] crop
 * in, which is what lets a box picked here be handed straight back as
 * `SwapOptions.targetFaceBox` with no conversion.
 *
 * It also means a caller cannot work out the scale on their own, so [imageWidth] and
 * [imageHeight] travel with every face. Without them, drawing this box over the original
 * file — the obvious thing to do with a detection API — silently lands in the wrong place
 * on any photo bigger than the cap, and there is no way to detect that from the outside.
 */
data class DetectedFace(
  val left: Float,
  val top: Float,
  val right: Float,
  val bottom: Float,
  /** Detector confidence, `0..1`. */
  val score: Float,
  /** Width of the analysed bitmap, the space [left]/[right] are in. */
  val imageWidth: Int,
  /** Height of the analysed bitmap, the space [top]/[bottom] are in. */
  val imageHeight: Int,
)

/**
 * Detects every face in a source photo, and crops to one of them for [PhotoSwap]/
 * [VideoSwap] to use as the identity instead of always "the largest" — see ADR-0012
 * (`docs/06-decisions/0012-source-face-picker-patches-ffjni.md`).
 *
 * [NativePipe.analyseFaces] is the one native symbol in this project that is not
 * upstream's own — a small, tracked patch (`docs/02-upstream.md` "Patches"), because
 * reaching the already-warm pipeline for a detect-only pass needed a new export inside
 * `ffjni.cpp` itself. Everything below this point is our own layer, same as the rest of
 * the app, and needed no further native changes: choosing a face is done by cropping the
 * source bitmap and calling the existing, unmodified `setSource`, not by a new native
 * "pick face N" entry point.
 */
object SourceFaces {

  /** Mirrors [PhotoSwap.ModelsMissing] — same required models a swap needs. */
  class ModelsMissing(message: String) : Exception(message)

  /** How much wider/taller than the detected box to crop, so `setSource`'s own detector
   *  sees the same kind of context it would in an uncropped photo instead of a box drawn
   *  exactly to the model's own edges — a hair too tight can lose the chin or forehead. */
  private const val MARGIN = 0.4f

  fun detect(context: Context, sourcePath: String, cfg: SwapConfig): List<DetectedFace> {
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

    val bitmap = decode(sourcePath)
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

  /**
   * Crops [bitmap] to the box `[left, top, right, bottom]` (as returned by [detect] /
   * [NativePipe.analyseFaces]), expanded by [MARGIN] on every side and clamped to the
   * bitmap's own bounds. The result is what gets handed to [NativePipe.setSource] — since
   * it contains only (or overwhelmingly) the chosen face, `setSource`'s own unmodified
   * "pick the largest face" logic naturally lands on it.
   */
  fun cropToFace(bitmap: Bitmap, box: FloatArray): Bitmap {
    require(box.size == 4) { "box must be [left, top, right, bottom]" }
    val (boxLeft, boxTop, boxRight, boxBottom) = box
    val w = boxRight - boxLeft
    val h = boxBottom - boxTop
    val left = (boxLeft - w * MARGIN).toInt().coerceIn(0, bitmap.width - 1)
    val top = (boxTop - h * MARGIN).toInt().coerceIn(0, bitmap.height - 1)
    val right = (boxRight + w * MARGIN).toInt().coerceIn(left + 1, bitmap.width)
    val bottom = (boxBottom + h * MARGIN).toInt().coerceIn(top + 1, bitmap.height)
    return Bitmap.createBitmap(bitmap, left, top, right - left, bottom - top)
  }

  // Duplicated from PhotoSwap rather than shared — see that file's note on the same choice.
  /**
   * Capped at [BitmapDecode.SOURCE_MAX] — **the same cap [PhotoSwap] decodes the source
   * with, and that is load-bearing.** The boxes this returns are in the decoded image's
   * pixel coordinates and come back as `SwapOptions.sourceFaceBox`; if the two paths
   * decoded at different scales, a picked face would crop the wrong region.
   */
  private fun decode(path: String): Bitmap =
    BitmapDecode.decode(path, BitmapDecode.SOURCE_MAX)

  private fun pixelsOf(bitmap: Bitmap): IntArray {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    return pixels
  }
}
