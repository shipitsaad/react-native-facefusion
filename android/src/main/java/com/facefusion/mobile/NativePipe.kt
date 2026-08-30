package com.facefusion.mobile

/**
 * The JNI surface of `libffnative.so`.
 *
 * **The package name is load-bearing.** JNI binds a Java/Kotlin `external fun` to a C
 * symbol by *name*: `ffjni.cpp` exports `Java_com_facefusion_mobile_NativePipe_probeTier`,
 * which resolves only to a method called `probeTier` on a class called `NativePipe` in
 * the package `com.facefusion.mobile`. Move or rename any part of that and the call
 * fails at runtime with `UnsatisfiedLinkError`, not at build time. So this one file
 * lives outside our own `com.facefusion` package, on purpose, and stays there.
 *
 * This is a Kotlin `object`, so the methods are instance methods on the singleton while
 * `ffjni.cpp` declares its second parameter as `jclass` (the static form). That is fine:
 * the mangled symbol name is identical either way, `jclass` and `jobject` are the same
 * pointer, and every one of these functions ignores that argument.
 *
 * Nothing but `external fun` declarations and the library load belongs here. All of our
 * own logic — path resolution, threading, parsing — lives in `com.facefusion`.
 *
 * Only the functions a shipped phase actually calls are declared. The rest of
 * `ffjni.cpp` (init, setSource, processFrame, the colour converters) arrives with the
 * phase that needs it.
 */
object NativePipe {

  /**
   * Null when `libffnative.so` loaded. Otherwise the reason it did not.
   *
   * The load is caught rather than thrown because a throw inside an `object` initialiser
   * poisons the class forever: the first access dies with `ExceptionInInitializerError`
   * and every access after it with a `NoClassDefFoundError` that no longer mentions the
   * real cause. A device without the library should get a clear message, not that.
   */
  var loadError: String? = null
    private set

  init {
    try {
      System.loadLibrary("ffnative")
    } catch (e: UnsatisfiedLinkError) {
      loadError = e.message ?: e.toString()
    }
  }

  /** The last error the native layer recorded. Empty when there has not been one. */
  external fun lastError(): String

  /**
   * The context-binary tier this chip needs — `"v68"` … `"v81"`.
   *
   * `libDir` must hold `libQnnHtp.so` and `libQnnSystem.so`; `skelDir` the matching
   * `libQnnHtpV<n>Skel.so`. In this package both are the app's `nativeLibraryDir`.
   *
   * Never throws and never returns empty: if the QNN backend cannot come up at all it
   * answers `"v68"`, the floor that runs everywhere. Check [probeDeviceInfo] to tell a
   * measured `v68` from a fallback one.
   */
  external fun probeTier(libDir: String, skelDir: String): String

  /** Every tier this chip can load, best first, comma-joined: `"v81,v73,v68"`. */
  external fun probeTierChain(libDir: String, skelDir: String): String

  /**
   * What the HTP reports, as `key=value;` pairs — `ok=1;arch=79;vtcm=8;soc=69;…`.
   *
   * `ok=0` means the probe **failed** and every other field is absent. It does not mean
   * the chip is old, and the two must never be collapsed into one answer.
   */
  external fun probeDeviceInfo(libDir: String, skelDir: String): String

  /**
   * Brings up the pipeline: QNN backend, every required context binary, the swap config.
   *
   * `modelDir` must hold `<name>_<tier>.bin` for the tier this chip measures internally —
   * the same resolution [com.facefusion.ModelPaths.tier] does against disk, so the two
   * are expected to agree (see that file's class doc). `padding` is `[top, right, bottom,
   * left]`, each `0..100`, or null for no padding.
   *
   * Expensive — `dlopen`s the QNN backend and finalises every graph — so callers keep the
   * pipeline warm across calls rather than calling this per swap. See [PipeGuard].
   */
  external fun initEx(
    libDir: String,
    skelDir: String,
    modelDir: String,
    swapperName: String,
    weight: Float,
    maskBlur: Float,
    padding: IntArray?,
    detectorScore: Float,
    landmarkerScore: Float,
    pixelBoost: Int,
    largestOnly: Boolean,
    faceEnhance: Boolean,
    enhanceBlend: Float,
  ): Boolean

  /** Tears down the pipeline built by [initEx]. Safe to call when nothing is initialised. */
  external fun release()

  /** Sets the source identity from one BGR image: the largest face's embedding only. */
  external fun setSource(bgr: ByteArray, w: Int, h: Int): Boolean

  /** Swaps every face in `bgr`, in place. Returns the face count found, or -1 on error. */
  external fun processFrame(bgr: ByteArray, w: Int, h: Int): Int

  /** `Bitmap.getPixels()` output (packed ARGB ints) -> packed BGR bytes for the pipeline. */
  external fun argbToBgr(argb: IntArray, w: Int, h: Int): ByteArray

  /**
   * Packed BGR bytes -> packed ARGB ints for `Bitmap.setPixels()`, optionally resampling to
   * `dstW`x`dstH`. Pass the source size for both to get an unscaled conversion.
   */
  external fun bgrToArgb(bgr: ByteArray, w: Int, h: Int, dstW: Int, dstH: Int): IntArray
}
