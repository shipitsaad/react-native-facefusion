package com.facefusion

import android.content.Context
import com.facefusion.mobile.NativePipe

/**
 * What this phone's Hexagon NPU says about itself.
 *
 * [ok] is the only field that decides whether the rest mean anything. `false` means the
 * probe failed — no QNN runtime, no Hexagon DSP, an emulator — and **not** that the chip
 * is old or unsupported. [tier] and [tierChain] are still filled in either way, because
 * the native layer's fallback (`v68`, the floor that runs on every HTP) is a usable
 * answer even when nothing could be measured.
 */
data class DeviceProbe(
  val ok: Boolean,
  val tier: String,
  val tierChain: List<String>,
  val arch: Int,
  val vtcmMb: Int,
  val socModel: Int,
  val signedPd: Boolean,
  val dlbc: Boolean,
  val error: String,
) {
  companion object {
    /** The tier every unmeasured device falls back to; mirrors `tierChain()` in ffqnn.cpp. */
    private const val FALLBACK_TIER = "v68"

    /**
     * Cached because the chain is a property of the *silicon* and cannot change while the
     * process lives, and because measuring it brings the QNN backend up — far too expensive
     * to repeat every time a screen wants to know which models to download.
     *
     * Only a real answer is cached. A probe that failed must not be remembered as "this chip
     * can load nothing" for the rest of the process, and the fallback is not a measurement.
     *
     * The chain is cached; the tier [ModelPaths.tier] resolves against disk deliberately is
     * not. What a device *can* load is fixed; what is *on disk* changes the moment a
     * download finishes.
     */
    @Volatile
    private var chainCache: List<String>? = null

    /**
     * Every tier this chip can load, best first — `["v81", "v73", "v68"]`.
     *
     * **Not** "this tier and every older one": the native `tierChain()` skips arches the
     * chip cannot run, so it must never be reconstructed from a single tier.
     *
     * Falls back to a one-entry `v68` chain when nothing could be measured, which is a
     * usable answer rather than an error — see the class docs.
     */
    fun tierChain(context: Context): List<String> {
      chainCache?.let { return it }
      if (NativePipe.loadError != null) return listOf(FALLBACK_TIER)

      val libDir = context.applicationInfo.nativeLibraryDir
      val chain = NativePipe.probeTierChain(libDir, libDir)
        .split(',')
        .map { it.trim() }
        .filter { it.isNotEmpty() }

      if (chain.isEmpty()) return listOf(FALLBACK_TIER)
      chainCache = chain
      return chain
    }

    /**
     * Runs the probe. **Blocking** — it `dlopen`s the QNN backend and creates a device
     * handle, which is tens of milliseconds on real hardware and a failed `dlopen`
     * anywhere else. Call it off the main thread.
     */
    fun probe(context: Context): DeviceProbe {
      NativePipe.loadError?.let { return failed("libffnative.so did not load: $it") }

      val chain = tierChain(context)

      // Both directories are the same one. The QAIRT runtime ships as ordinary .so files
      // in jniLibs, so the installer extracts backend, stub and skel side by side into
      // the app's nativeLibraryDir -- and that extraction is exactly what
      // `useLegacyPackaging = true` guarantees, because the backend is opened by path.
      val libDir = context.applicationInfo.nativeLibraryDir
      val info = parse(NativePipe.probeDeviceInfo(libDir, libDir))
      val ok = info["ok"] == "1"

      return DeviceProbe(
        ok = ok,
        tier = chain.first(),
        tierChain = chain,
        arch = info["arch"]?.toIntOrNull() ?: 0,
        vtcmMb = info["vtcm"]?.toIntOrNull() ?: 0,
        socModel = info["soc"]?.toIntOrNull() ?: 0,
        signedPd = info["signedPd"] == "1",
        dlbc = info["dlbc"] == "1",
        // lastError() is whatever failed most recently, so it is only meaningful when
        // something did. Reading it on the success path would report a stale message.
        error = if (ok) "" else NativePipe.lastError(),
      )
    }

    private fun failed(reason: String) = DeviceProbe(
      ok = false,
      tier = FALLBACK_TIER,
      tierChain = listOf(FALLBACK_TIER),
      arch = 0,
      vtcmMb = 0,
      socModel = 0,
      signedPd = false,
      dlbc = false,
      error = reason,
    )

    /** `ok=1;arch=79;vtcm=8;…` -> a map. Pairs without an `=` are dropped. */
    private fun parse(info: String): Map<String, String> =
      info.split(';')
        .mapNotNull { field ->
          val i = field.indexOf('=')
          if (i <= 0) null else field.substring(0, i) to field.substring(i + 1)
        }
        .toMap()
  }
}
