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
}
