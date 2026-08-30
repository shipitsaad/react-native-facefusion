package com.facefusion

import android.content.Context
import android.view.SurfaceHolder
import android.view.SurfaceView

/**
 * The RN-mounted view behind `<FacefusionPreview />`. Holds no swap logic of its own — it
 * only owns a [SurfaceView] and forwards its [Surface][android.view.Surface] lifecycle to
 * [PreviewSurfaceHolder], which is what [PhotoSwap] and [VideoSwap] actually draw into.
 */
class FacefusionPreviewView(context: Context) : SurfaceView(context), SurfaceHolder.Callback {

  init {
    holder.addCallback(this)
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    PreviewSurfaceHolder.attach(holder.surface)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
    // No cached size to update -- PreviewSurfaceHolder.draw() reads the Canvas's own
    // width/height fresh from lockCanvas() every frame.
  }

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    PreviewSurfaceHolder.detach(holder.surface)
  }
}
