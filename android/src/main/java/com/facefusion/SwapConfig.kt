package com.facefusion

/**
 * JS-tunable knobs for a swap, mirroring `ffpipe::Config`'s defaults for the `hyperswap`
 * swapper ([ModelPaths.SWAPPER]) field for field.
 *
 * [maskPadding] is `[top, right, bottom, left]`, each `0..100`; out-of-range values are
 * clamped again on the C++ side (`initEx` in `ffjni.cpp`), so this is a convenience default,
 * not the only safety net.
 */
data class SwapConfig(
  val swapperWeight: Float = 0.5f,
  val maskBlur: Float = 0.3f,
  val maskPadding: List<Int> = listOf(0, 0, 0, 0),
  val detectorScore: Float = 0.5f,
  val landmarkerScore: Float = 0.5f,
  val pixelBoost: Int = 1,
  val largestFaceOnly: Boolean = false,
  val faceEnhance: Boolean = false,
  val faceEnhancerBlend: Float = 0.8f,
) {
  /**
   * Identifies this config for [PipeGuard]'s "does the pipeline need reloading" check.
   * A plain string rather than relying on `data class` equality because the values that
   * matter are the ones that cross into `initEx`, not Kotlin identity.
   */
  fun signature(): String = listOf(
    swapperWeight, maskBlur, maskPadding.joinToString(","), detectorScore,
    landmarkerScore, pixelBoost, largestFaceOnly, faceEnhance, faceEnhancerBlend,
  ).joinToString("|")
}
