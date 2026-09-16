package com.facefusion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF

/**
 * Stamps a small corner of a swapped frame to say the frame is AI-generated.
 *
 * This exists because of what this project sits downstream of, not because it looked
 * nice to add. FaceFusion (Henry Ruhs), licensed OpenRAIL-AS, prohibits generating or
 * disseminating machine-generated content "without expressly and intelligibly
 * disclaiming that it is machine-generated" — see `third_party/facefusion-mobile/NOTICE`.
 * Metadata alone (EXIF, a container tag) does not satisfy that: it is stripped by almost
 * every real sharing path — a screenshot, a re-encode, WhatsApp's own recompression — so
 * the mark has to be burned into pixels a viewer actually sees, not into a field most
 * viewers never look at.
 *
 * Works directly on the raw, packed BGR buffer [PhotoSwap] and [VideoSwap] already carry —
 * `bgr[i*3+0]=B, [1]=G, [2]=R`, confirmed against `argbToBgr` in the vendored `ffjni.cpp`,
 * not assumed — so there is one stamping implementation shared by both, rather than a
 * Bitmap/Canvas path for the still and a second, separate one for video's per-frame loop.
 */
object Watermark {

  // Held off both edges, not just tucked in a literal corner -- some players' UI chrome
  // (a scrubber, a caption) sits exactly there.
  private const val MARGIN_FRACTION = 0.02f
  private const val TEXT = "AI-GENERATED · FACE SWAP"

  /**
   * One badge, pre-rendered for a specific frame size. Build it once per swap call — the
   * text and its size are fixed for that call's frames, and re-rendering per frame would
   * mean a fresh [Bitmap]/[Canvas] every single frame of a video for no benefit — then
   * call [stamp] on every output frame of that same swap.
   */
  class Badge internal constructor(
    private val pixels: IntArray,
    private val w: Int,
    private val h: Int,
    private val marginX: Int,
    private val marginY: Int,
  ) {
    /**
     * Alpha-blends this badge onto [bgr]'s bottom-right corner, in place.
     *
     * Silently does nothing if [frameW]/[frameH] are too small to fit the badge with its
     * margin — skipping the mark on a frame that cannot fit it is safer than guessing at a
     * smaller size and risking writing outside the buffer.
     */
    fun stamp(bgr: ByteArray, frameW: Int, frameH: Int) {
      if (frameW < w + marginX * 2 || frameH < h + marginY * 2) return
      val ox = frameW - w - marginX
      val oy = frameH - h - marginY
      for (by in 0 until h) {
        val srcRow = by * w
        val destRow = (oy + by) * frameW
        for (bx in 0 until w) {
          val argb = pixels[srcRow + bx]
          val alpha = (argb ushr 24) and 0xFF
          if (alpha == 0) continue
          val a = alpha / 255f
          val inv = 1f - a
          val r = (argb ushr 16) and 0xFF
          val g = (argb ushr 8) and 0xFF
          val b = argb and 0xFF
          val idx = (destRow + ox + bx) * 3
          bgr[idx] = (b * a + (bgr[idx].toInt() and 0xFF) * inv).toInt().coerceIn(0, 255).toByte()
          bgr[idx + 1] =
            (g * a + (bgr[idx + 1].toInt() and 0xFF) * inv).toInt().coerceIn(0, 255).toByte()
          bgr[idx + 2] =
            (r * a + (bgr[idx + 2].toInt() and 0xFF) * inv).toInt().coerceIn(0, 255).toByte()
        }
      }
    }
  }

  /** Renders a [Badge] sized for a [frameW] x [frameH] frame. Text size and margins scale
   *  with the frame so the mark stays legible on a 4K clip and unobtrusive on a small
   *  photo, clamped so it never becomes either illegibly tiny or absurdly large. */
  fun forFrameSize(frameW: Int, frameH: Int): Badge {
    val textSizePx = (frameH * 0.028f).coerceIn(14f, 40f)
    val paddingPx = (textSizePx * 0.5f).coerceAtLeast(6f)

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.WHITE
      textSize = textSizePx
      isFakeBoldText = true
      textAlign = Paint.Align.LEFT
    }
    val textWidth = paint.measureText(TEXT)
    val badgeW = (textWidth + paddingPx * 2).toInt().coerceAtLeast(1)
    val badgeH = (textSizePx + paddingPx * 2).toInt().coerceAtLeast(1)

    val bitmap = Bitmap.createBitmap(badgeW, badgeH, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val bgPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = Color.BLACK
      alpha = 160
    }
    val corner = paddingPx * 0.6f
    canvas.drawRoundRect(RectF(0f, 0f, badgeW.toFloat(), badgeH.toFloat()), corner, corner, bgPaint)
    // Paint has no "draw vertically centred" call -- this is the standard baseline formula
    // for it: the midpoint of the glyph box sits at -(ascent + descent) / 2 above baseline.
    val baseline = badgeH / 2f - (paint.descent() + paint.ascent()) / 2f
    canvas.drawText(TEXT, paddingPx, baseline, paint)

    val pixels = IntArray(badgeW * badgeH)
    bitmap.getPixels(pixels, 0, badgeW, 0, 0, badgeW, badgeH)
    bitmap.recycle()

    val marginX = (frameW * MARGIN_FRACTION).toInt().coerceAtLeast(4)
    val marginY = (frameH * MARGIN_FRACTION).toInt().coerceAtLeast(4)
    return Badge(pixels, badgeW, badgeH, marginX, marginY)
  }
}
