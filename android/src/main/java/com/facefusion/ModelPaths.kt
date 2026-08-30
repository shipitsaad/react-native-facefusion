package com.facefusion

import android.content.Context
import java.io.File

/**
 * Where the model files live, and which tier this install will actually load.
 *
 * There is exactly one rule for both answers because the native side has its own copy of
 * it: `Pipeline::init` in `ffpipe.cpp` resolves the tier against disk the same way. If
 * this file names a tier the pipeline will not open, "models missing" and "model loaded"
 * disagree on the same device and the result reads like a download bug rather than a
 * mismatch. Any change here is a change to `ffpipe.cpp:88-95` as well.
 */
object ModelPaths {

  /** The swap model. Upstream's `Pipeline::init` takes this as a parameter; we ship one. */
  const val SWAPPER = "hyperswap"

  /**
   * The models the pipeline refuses to start without, by base name.
   *
   * `gpen` (the face enhancer) is deliberately absent — `Pipeline::init` opens it without
   * checking, so a missing enhancer is a feature that is off, not a broken install.
   */
  private val REQUIRED = listOf("yoloface", "fan2d", "arcface", SWAPPER)

  /** The content gate, in the native layer's preference order: fp32 first, quantised second. */
  private val GATE = listOf("nsfw", "nsfwq")

  /**
   * The models directory, created by us.
   *
   * App-specific external storage: no permission is needed on any supported Android
   * version, the OS deletes it with the app, and — unlike internal storage — it can be
   * listed over adb while debugging. `getExternalFilesDir` returns null when external
   * storage is not mounted, which is rare but real, so internal storage is the fallback.
   *
   * `mkdirs()` here matters more than it looks: a directory created by `adb push` is owned
   * by the `shell` user and this app cannot traverse it, which surfaces as `open()` failing
   * with a bare ENOENT on a file that is plainly there. Creating it ourselves first avoids
   * inheriting someone else's ownership.
   */
  fun dir(context: Context): File {
    val base = context.getExternalFilesDir(null) ?: context.filesDir
    return File(base, "models").apply { mkdirs() }
  }

  /**
   * The tier this install will load: the best one whose files are on disk, else the best
   * this chip could load.
   *
   * **Never cache this**, and never substitute the probe's `tier` for it. That one is
   * `tierChain().first()` — what the *silicon* can load, with no reference to disk. The two
   * differ on exactly the devices whose best arch is not published yet: an 8 Elite Gen 5
   * resolves the chain `v81,v73,v68`, the manifest currently publishes no v81, the
   * downloader correctly fetches **v73**, and anything that then names files `_v81` reports
   * a complete download as missing. That shipped in upstream's 0.2.0. Recomputing is a
   * handful of `canRead()` calls; the chain is what was expensive, and that is cached.
   */
  fun tier(context: Context): String {
    val chain = DeviceProbe.tierChain(context)
    val dir = dir(context)
    // The detector is the probe because it is mandatory and the smallest file in the set.
    // A tier is never half present: the downloader writes `<name>.part` and renames only
    // after the SHA-256 matches, so yoloface being there means the rest of that tier is.
    return chain.firstOrNull { File(dir, "yoloface_$it.bin").canRead() } ?: chain.first()
  }

  /**
   * Which required models are absent for [tier], by base name. Empty means ready to run.
   *
   * The content gate counts as required because it *blocks*: without it there is nothing to
   * refuse with, and a run that cannot check is a run that must not happen. Either build
   * satisfies it — fp32 `nsfw_`, or the quantised `nsfwq_` that every tier below v79
   * carries because the fp32 GELU will not compile for them.
   */
  fun missing(context: Context, tier: String): List<String> {
    val dir = dir(context)
    val absent = REQUIRED.filterNot { File(dir, "${it}_$tier.bin").canRead() }.toMutableList()
    if (GATE.none { File(dir, "${it}_$tier.bin").canRead() }) absent += "nsfw"
    return absent
  }

  /** Whether the optional face enhancer is on disk for [tier]. */
  fun hasEnhancer(context: Context, tier: String): Boolean =
    File(dir(context), "gpen_$tier.bin").canRead()
}
