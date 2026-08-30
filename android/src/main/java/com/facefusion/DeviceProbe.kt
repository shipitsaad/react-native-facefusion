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
     * Runs the probe. **Blocking** — it `dlopen`s the QNN backend and creates a device
     * handle, which is tens of milliseconds on real hardware and a failed `dlopen`
     * anywhere else. Call it off the main thread.
     */
    fun probe(context: Context): DeviceProbe {
      NativePipe.loadError?.let { return failed("libffnative.so did not load: $it") }

      // Both directories are the same one. The QAIRT runtime ships as ordinary .so files
      // in jniLibs, so the installer extracts backend, stub and skel side by side into
      // the app's nativeLibraryDir -- and that extraction is exactly what
      // `useLegacyPackaging = true` guarantees, because the backend is opened by path.
      val libDir = context.applicationInfo.nativeLibraryDir

      val chain = NativePipe.probeTierChain(libDir, libDir)
        .split(',')
        .filter { it.isNotEmpty() }
        .ifEmpty { listOf(FALLBACK_TIER) }

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
