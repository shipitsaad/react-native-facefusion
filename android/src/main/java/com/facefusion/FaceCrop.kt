package com.facefusion

/**
 * Crops a packed BGR frame to one face's box, and pastes a same-sized crop back — how
 * [PhotoSwap]/[VideoSwap] swap only a chosen *target* face without a new native entry
 * point: [com.facefusion.mobile.NativePipe.processFrame] already swaps every face it's
 * handed, so handing it a tight crop around one face swaps only that one. The same trick
 * [SourceFaces] already uses on the source side for `setSource` — this is the BGR-buffer
 * version of it, since [PhotoSwap]/[VideoSwap] both work in packed BGR, not `Bitmap`s, by
 * the time a target face box would apply.
 */
object FaceCrop {

  /** Same margin [SourceFaces] uses on the source side, for the same reason: the
   *  detector/landmarker inside `processFrame` need a bit of surrounding context, not a
   *  box drawn exactly to the model's own edges. */
  const val MARGIN = 0.4f

  /** [box] (`[left, top, right, bottom]`, as returned by [TargetFaces.detect]) expanded by
   *  [margin] and clamped to `0..w`/`0..h`, as pixel ints. */
  fun rect(box: FloatArray, w: Int, h: Int, margin: Float = MARGIN): IntArray {
    require(box.size == 4) { "box must be [left, top, right, bottom]" }
    val (boxLeft, boxTop, boxRight, boxBottom) = box
    val bw = boxRight - boxLeft
    val bh = boxBottom - boxTop
    val left = (boxLeft - bw * margin).toInt().coerceIn(0, w - 1)
    val top = (boxTop - bh * margin).toInt().coerceIn(0, h - 1)
    val right = (boxRight + bw * margin).toInt().coerceIn(left + 1, w)
    val bottom = (boxBottom + bh * margin).toInt().coerceIn(top + 1, h)
    return intArrayOf(left, top, right, bottom)
  }

  /** Extracts `rect` from a packed BGR buffer (3 bytes/pixel, no row padding) of width [w]. */
  fun crop(bgr: ByteArray, w: Int, rect: IntArray): ByteArray {
    val left = rect[0]
    val top = rect[1]
    val cw = rect[2] - left
    val ch = rect[3] - top
    val out = ByteArray(cw * ch * 3)
    for (row in 0 until ch) {
      System.arraycopy(bgr, ((top + row) * w + left) * 3, out, row * cw * 3, cw * 3)
    }
    return out
  }

  /** Writes a buffer from [crop] back into [bgr] (width [w]) at [rect]. The inverse of
   *  [crop] — call with the same `rect` used to produce it. */
  fun paste(bgr: ByteArray, w: Int, cropped: ByteArray, rect: IntArray) {
    val left = rect[0]
    val top = rect[1]
    val cw = rect[2] - left
    val ch = rect[3] - top
    for (row in 0 until ch) {
      System.arraycopy(cropped, row * cw * 3, bgr, ((top + row) * w + left) * 3, cw * 3)
    }
  }
}
