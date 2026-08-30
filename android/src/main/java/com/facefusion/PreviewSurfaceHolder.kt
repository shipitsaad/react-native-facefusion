package com.facefusion

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.view.Surface

/**
 * The live-preview sink for [PhotoSwap] and [VideoSwap]: a global holder for whichever
 * [FacefusionPreviewView] is currently mounted, if any.
 *
 * **Why a singleton rather than a parameter threaded through the swap call.** `g_pipe` is
 * already a single C++ global — only one swap can run at a time ([PipeGuard]) — so there is
 * never more than one frame stream to preview. A JS-side prop or a second TurboModule call
 * to "attach" a surface would need to cross the bridge with a view reference; a plain object
 * both sides can reach avoids that, and mirrors how [NativePipe] itself is one process-wide
 * object rather than an instance per swap.
 *
 * **Never touches [NativePipe] or the vendored C++.** `bgr`/`w`/`h` here are exactly the
 * bytes [VideoSwap] and [PhotoSwap] already hold in JVM memory after [NativePipe.processFrame]
 * returns — this only has to get them onto a [Surface]'s [Canvas], which is a plain Android
 * API. That is what keeps this out of the "never pass frames across the JS bridge" rule: no
 * pixel ever reaches JS, only the mounted `<FacefusionPreview />` view does, and rendering
 * happens entirely on the native side of it.
 */
object PreviewSurfaceHolder {

  // Caps preview redraws independent of how fast the swap loop itself runs -- a 720p frame
  // decoded to a Bitmap and blitted to a Canvas is not free, and the swap loop's own pace
  // (tens of fps) is faster than a screen needs to look "live". ~15 fps is smooth to the eye
  // and cheap enough not to be the thing that slows the swap down.
  private const val MIN_INTERVAL_NANOS = 66_000_000L

  @Volatile
  private var surface: Surface? = null

  @Volatile
  private var lastDrawNanos = 0L

  /** Called by [FacefusionPreviewView] once its [Surface] exists. */
  fun attach(newSurface: Surface) {
    surface = newSurface
    lastDrawNanos = 0L
  }

  /** Called by [FacefusionPreviewView] when its [Surface] is torn down. Idempotent. */
  fun detach(oldSurface: Surface) {
    // Only clear if it's still the same surface -- a fast unmount+remount (view recycling)
    // could otherwise have a stale detach() race ahead of the new attach() and wipe it.
    if (surface === oldSurface) surface = null
  }

  /**
   * Draws one BGR frame, letterboxed to fit the attached surface. A no-op — one [Volatile]
   * read — when nothing is mounted, so [VideoSwap]'s loop pays nothing when no preview is
   * showing. Also a no-op inside the throttle window.
   *
   * Safe to call from any thread; [VideoSwap] and [PhotoSwap] both call it from their own
   * worker thread, never the UI thread.
   */
  fun draw(bgr: ByteArray, w: Int, h: Int) {
    val target = surface ?: return
    if (!target.isValid) return

    val now = System.nanoTime()
    if (now - lastDrawNanos < MIN_INTERVAL_NANOS) return

    val argb = com.facefusion.mobile.NativePipe.bgrToArgb(bgr, w, h, w, h)
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bitmap.setPixels(argb, 0, w, 0, 0, w, h)

    // lockCanvas/unlockCanvasAndPost can throw if the surface is torn down concurrently with
    // this call (SurfaceHolder.Callback runs on the UI thread, this runs on the swap
    // worker) -- caught rather than synchronized against, since a dropped preview frame
    // during teardown is harmless and a lock here would block the swap loop on the UI thread.
    try {
      val canvas: Canvas = target.lockCanvas(null)
      try {
        val dst = fitRect(w, h, canvas.width, canvas.height)
        canvas.drawColor(android.graphics.Color.BLACK)
        canvas.drawBitmap(bitmap, null, dst, null)
      } finally {
        target.unlockCanvasAndPost(canvas)
      }
      lastDrawNanos = now
    } catch (_: Exception) {
      // Surface gone or going -- next attach() (or the next frame, if it recovers) picks
      // back up. Nothing here is worth crashing a swap over.
    } finally {
      bitmap.recycle()
    }
  }

  /** Centers a `srcW`x`srcH` rect inside `dstW`x`dstH`, preserving aspect ratio. */
  private fun fitRect(srcW: Int, srcH: Int, dstW: Int, dstH: Int): Rect {
    if (srcW <= 0 || srcH <= 0 || dstW <= 0 || dstH <= 0) return Rect(0, 0, dstW, dstH)
    val scale = minOf(dstW.toFloat() / srcW, dstH.toFloat() / srcH)
    val w = (srcW * scale).toInt()
    val h = (srcH * scale).toInt()
    val left = (dstW - w) / 2
    val top = (dstH - h) / 2
    return Rect(left, top, left + w, top + h)
  }
}
