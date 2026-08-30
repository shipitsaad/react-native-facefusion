package com.facefusion

import android.content.Context
import com.facefusion.mobile.NativePipe
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Owns the single native pipeline (`g_pipe`, a C++ global in `ffjni.cpp`) and the fact that
 * only one job can use it at a time.
 *
 * Ported from upstream's `PipeGuard.kt` (see `docs/02-upstream.md`) — not copied, since only
 * the C++ is vendored (ADR-0005) and upstream's Kotlin was never fetched. This reproduces the
 * *behaviour* upstream's class docs describe: a video swap can run for minutes, and a second
 * caller queued behind that on the same lock would look indistinguishable from a hang. So a
 * second job is rejected immediately with [Busy] instead of waiting, the same shape as
 * [ModelDownload]'s `E_BUSY` check.
 *
 * Re-initialising the pipeline is expensive — it `dlopen`s the QNN backend and finalises
 * every graph — so it is kept warm across calls and only reloaded when [SwapConfig] or the
 * resolved tier actually changed. See ADR-0008.
 */
object PipeGuard {
  class Busy : Exception("A face-swap job is already running")

  private val busy = AtomicBoolean(false)

  @Volatile
  private var initedSignature: String? = null

  /**
   * Runs [block] with the native pipeline initialised for [tier]/[cfg], holding the single
   * job slot for the duration.
   *
   * @throws Busy immediately if another job already holds the slot.
   * @throws IllegalStateException if `initEx` fails; [NativePipe.lastError] names why.
   */
  fun <T> run(context: Context, tier: String, cfg: SwapConfig, block: () -> T): T {
    if (!busy.compareAndSet(false, true)) throw Busy()
    try {
      ensureInit(context, tier, cfg)
      return block()
    } finally {
      busy.set(false)
    }
  }

  private fun ensureInit(context: Context, tier: String, cfg: SwapConfig) {
    val signature = "$tier|${cfg.signature()}"
    if (signature == initedSignature) return

    val libDir = context.applicationInfo.nativeLibraryDir
    val modelDir = ModelPaths.dir(context).absolutePath
    val ok = NativePipe.initEx(
      libDir,
      libDir,
      modelDir,
      ModelPaths.SWAPPER,
      cfg.swapperWeight,
      cfg.maskBlur,
      cfg.maskPadding.toIntArray(),
      cfg.detectorScore,
      cfg.landmarkerScore,
      cfg.pixelBoost,
      cfg.largestFaceOnly,
      cfg.faceEnhance,
      cfg.faceEnhancerBlend,
    )
    if (!ok) {
      initedSignature = null
      throw IllegalStateException(NativePipe.lastError())
    }
    initedSignature = signature
  }
}
