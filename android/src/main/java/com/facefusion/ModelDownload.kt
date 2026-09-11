package com.facefusion

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/** One file in the hosted manifest. */
data class ModelFile(val name: String, val bytes: Long, val sha256: String)

/** The best tier the manifest actually publishes for this chip, and its files. */
data class ModelManifest(val tier: String, val files: List<ModelFile>)

/** A snapshot of a download in flight. Bytes are across the whole set, not the current file. */
data class DownloadProgress(
  val tier: String,
  val fileIndex: Int,
  val fileCount: Int,
  val name: String,
  val doneBytes: Long,
  val totalBytes: Long,
)

/** Thrown by [ModelDownload.run] when [ModelDownload.cancel] was called. The `.part` files stay. */
class DownloadCancelled : IOException("Cancelled")

/**
 * Fetching the NPU context binaries for this device's tier.
 *
 * The models are not in the APK and never will be: the set is ~317 MB, and several of the
 * models carry licences that are not ours to sublicense (`docs/04-models.md`). They are
 * hosted on Hugging Face and pulled on first run — the same thing FaceFusion itself does.
 *
 * Two properties this has to have, both of which upstream learned the hard way:
 *
 *  * **Resumable.** A 206 MB file over a phone link is not an atomic operation. Bytes land
 *    in `<name>.part` and a retry continues from its length with an HTTP Range request.
 *  * **Verified.** A context binary that is short does not fail loudly — it fails at load,
 *    four layers away from the cause, inside Qualcomm's runtime. So every file is SHA-256'd
 *    against the manifest before it is allowed to take its real name.
 */
object ModelDownload {

  /**
   * Versioned per *model* revision, not per app version — the `-0.1.0` is upstream's model
   * revision and stays put while the app moves, so an old build keeps resolving the files
   * it was tested against.
   */
  const val REPO = "AbrahamPJ/facefusion-mobile-models-0.1.0"

  private const val BASE = "https://huggingface.co/$REPO/resolve/main/"
  private const val TAG = "ffmodels"

  /**
   * What a manifest entry's `name` is allowed to be: a bare `.bin` filename, nothing else.
   *
   * The name arrives from a **remote** JSON and is then used both as a URL suffix and as
   * `File(dir, name)`. Without this, a `name` of `../../shared_prefs/something` would write
   * outside the models directory — and SHA-256 verification is no defence at all here,
   * because the same manifest that supplies the path also supplies the expected hash.
   *
   * This is not a hypothetical about upstream's intentions; it is that this is a library
   * other people ship, the host is a third party neither they nor we control, and the check
   * costs one regex. A rejected entry throws rather than being skipped: a downloader that
   * quietly ignores part of the set produces a half-tier that fails later inside Qualcomm's
   * runtime, which is the exact failure mode this file's header says to avoid.
   */
  private val SAFE_NAME = Regex("""^[A-Za-z0-9][A-Za-z0-9._-]*\.bin$""")
  private const val CONNECT_TIMEOUT_MS = 30_000
  private const val READ_TIMEOUT_MS = 60_000
  private const val BUFFER = 1 shl 16

  /** How often progress is reported. The UI cannot use more, and each tick crosses to JS. */
  private const val TICK_MS = 250L

  @Volatile
  private var cancelled = false

  /** Asks the run in flight to stop. Idempotent, and safe to call when nothing is running. */
  fun cancel() {
    cancelled = true
  }

  /** True when the connection is metered, so a caller can warn before spending ~317 MB. */
  fun isMetered(context: Context): Boolean {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    return !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
  }

  /**
   * Which files to fetch, from the hosted manifest. Network call; never on the main thread.
   *
   * Takes the whole tier **chain** rather than one tier and returns the best entry the
   * manifest actually publishes. The two differ whenever the app knows about an arch whose
   * binaries are not hosted — which is the normal state for a while after a new chip lands,
   * and is not hypothetical: v81 is in the chain of every 8 Elite Gen 5 and was withheld
   * from the manifest on 2026-08-30 because the binaries had never been run on v81 silicon.
   * Resolving against the manifest turns that from "no models published for tier v81" into
   * a working v73 install. See ADR-0007.
   */
  fun manifestFor(chain: List<String>): ModelManifest {
    require(chain.isNotEmpty()) { "no tier requested" }

    val tiers = org.json.JSONObject(get(BASE + "manifest.json")).getJSONObject("tiers")

    // The best tier that is both published AND actually usable. "Published" is not enough:
    // as of 2026-09-11 upstream publishes v81 whose only gate-shaped file is `nsfwq2`,
    // which `Pipeline::init` never opens -- so an 8 Elite Gen 5 that downloaded v81 would
    // fetch 305 MB and then fail init outright with "no content gate", which is a hard
    // failure and not a recoverable one.
    //
    // Falling through to the next tier in the chain instead is exactly the machinery
    // ADR-0007 exists for, keyed on "can the pipeline use this" rather than the weaker
    // "does the manifest mention it". The native side then picks the same tier on its own,
    // because it probes which tier's files are actually on disk.
    val tier = chain.firstOrNull { tiers.has(it) && hasUsableGate(tiers, it) }
      ?: throw IOException(
        "no usable models published for any of ${chain.joinToString(", ")} — a tier must " +
          "ship ${ModelPaths.GATE.joinToString(" or ")} for the content gate to run"
      )

    val files = tiers.getJSONObject(tier).getJSONArray("files")
    return ModelManifest(
      tier = tier,
      files = (0 until files.length()).map {
        val o = files.getJSONObject(it)
        val name = o.getString("name")
        // Validated here, at the parse boundary, so nothing downstream can ever hold an
        // unsafe name -- see [SAFE_NAME].
        if (!SAFE_NAME.matches(name)) {
          throw IOException("manifest for $tier names an unacceptable file: '$name'")
        }
        ModelFile(name, o.getLong("bytes"), o.getString("sha256"))
      }
        // Only what `Pipeline::init` actually opens -- see [ModelPaths.OPENED_BY_PIPELINE].
        // Filtered here, at the one place the manifest is read, so the byte totals, the
        // progress events, `notPresent` and the log line below all agree about what this
        // run is for. Filtering later would have the progress bar counting files nothing
        // fetches.
        .filter { isOpenedByPipeline(it.name, tier) },
    )
  }

  /**
   * Whether [tier]'s published file list includes a content gate the native layer opens.
   *
   * A tier without one cannot start at all — see the call site in [manifestFor] — so this
   * is a precondition for choosing a tier, not a detail of what to download from it.
   */
  private fun hasUsableGate(tiers: org.json.JSONObject, tier: String): Boolean {
    val files = tiers.getJSONObject(tier).optJSONArray("files") ?: return false
    val names = (0 until files.length()).map { files.getJSONObject(it).optString("name") }
    return ModelPaths.GATE.any { "${it}_$tier.bin" in names }
  }

  /**
   * Whether `name` is one of the models the native pipeline opens, for this [tier].
   *
   * Manifest names are `<base>_<tier>.bin`, so the tier suffix is stripped and the base
   * checked against [ModelPaths.OPENED_BY_PIPELINE]. A file for a *different* tier would
   * not match and is skipped, which is correct — the manifest only lists one tier's files
   * per tier object, but being explicit costs nothing and makes a malformed manifest
   * under-fetch rather than fetch the wrong tier's 206 MB swapper.
   */
  private fun isOpenedByPipeline(name: String, tier: String): Boolean {
    val suffix = "_$tier.bin"
    if (!name.endsWith(suffix)) return false
    return name.removeSuffix(suffix) in ModelPaths.OPENED_BY_PIPELINE
  }

  /**
   * Which of [files] are not already present at their full length in [dir].
   *
   * Length only, not hash: re-reading 317 MB to decide whether to download it would cost
   * seconds on every launch. The hash is checked once, when the file is committed, and a
   * file that is the right length but wrong content would have failed that check and never
   * been renamed.
   */
  fun notPresent(dir: File, files: List<ModelFile>): List<ModelFile> =
    files.filter { f ->
      val onDisk = File(dir, f.name)
      !onDisk.canRead() || onDisk.length() != f.bytes
    }

  /**
   * Download everything missing for the best published tier in [chain].
   *
   * Blocking — call it from a worker thread. Returns the tier that was fetched. Throws
   * [DownloadCancelled] if cancelled, or an [IOException] naming the file that failed.
   */
  fun run(dir: File, chain: List<String>, onProgress: (DownloadProgress) -> Unit): String {
    cancelled = false

    val manifest = manifestFor(chain)
    val todo = notPresent(dir, manifest.files)

    // Say what is about to be fetched and what was kept. A resumed download that re-fetches
    // a 206 MB file it already had and one that fetches only what is missing look identical
    // from outside -- a progress bar and a wait.
    Log.i(
      TAG,
      "tier ${manifest.tier}: ${manifest.files.size} files, fetching ${todo.map { it.name }}, " +
        "keeping ${manifest.files.filterNot { f -> todo.any { it.name == f.name } }.map { it.name }}",
    )

    val totalBytes = todo.sumOf { it.bytes }
    var doneBytes = 0L

    for ((i, file) in todo.withIndex()) {
      throwIfCancelled()
      val startedAt = doneBytes
      fetch(dir, file) { fileBytes ->
        doneBytes = startedAt + fileBytes
        onProgress(
          DownloadProgress(manifest.tier, i + 1, todo.size, file.name, doneBytes, totalBytes)
        )
      }
      doneBytes = startedAt + file.bytes
    }

    // One final tick so a caller that only ever sees ticks lands on 100% rather than on
    // whatever the last 250 ms boundary happened to be.
    onProgress(
      DownloadProgress(manifest.tier, todo.size, todo.size, "", totalBytes, totalBytes)
    )
    return manifest.tier
  }

  /**
   * One file, resuming its `.part` if there is one.
   *
   * [onBytes] is called with the bytes transferred *for this file*, throttled; the caller
   * adds the running total. The temp file only takes its real name after the hash matches,
   * so a partial or corrupt download can never present itself to the loader as a model.
   */
  private fun fetch(dir: File, file: ModelFile, onBytes: (Long) -> Unit) {
    val part = File(dir, file.name + ".part")
    val dest = File(dir, file.name)

    // A .part longer than the target is left over from a different revision of the file;
    // resuming from it would append good bytes onto wrong ones.
    if (part.exists() && part.length() > file.bytes) part.delete()

    var from = if (part.exists()) part.length() else 0L
    if (from == file.bytes) {
      // Fully transferred last time but the process died before it was verified.
      verifyAndCommit(part, dest, file)
      return
    }

    val conn = (URL(BASE + file.name).openConnection() as HttpURLConnection).apply {
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
      if (from > 0) setRequestProperty("Range", "bytes=$from-")
    }
    try {
      val code = conn.responseCode
      if (from > 0 && code != HttpURLConnection.HTTP_PARTIAL) {
        // The server ignored the Range, so the bytes coming back start at zero. Appending
        // them to the .part would corrupt it silently -- the length would look plausible.
        part.delete()
        from = 0
      }
      if (code != HttpURLConnection.HTTP_OK && code != HttpURLConnection.HTTP_PARTIAL) {
        throw IOException("${file.name}: HTTP $code")
      }

      var written = from
      onBytes(written)
      conn.inputStream.use { input ->
        FileOutputStream(part, from > 0).use { out ->
          val buf = ByteArray(BUFFER)
          var lastTick = 0L
          while (true) {
            throwIfCancelled()
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            written += n
            val now = System.currentTimeMillis()
            if (now - lastTick > TICK_MS) {
              lastTick = now
              onBytes(written)
            }
          }
        }
      }
    } finally {
      // The .part is deliberately kept on failure: it is exactly what a resume needs.
      conn.disconnect()
    }

    throwIfCancelled()
    verifyAndCommit(part, dest, file)
  }

  private fun verifyAndCommit(part: File, dest: File, file: ModelFile) {
    if (part.length() != file.bytes) {
      part.delete()
      throw IOException("${file.name}: expected ${file.bytes} bytes, got ${part.length()}")
    }
    val actual = sha256(part)
    if (!actual.equals(file.sha256, ignoreCase = true)) {
      // Not resumable: a hash mismatch means the bytes are wrong, not that they are short.
      part.delete()
      throw IOException("${file.name}: checksum mismatch")
    }
    dest.delete()
    if (!part.renameTo(dest)) throw IOException("${file.name}: could not be saved")
  }

  private fun sha256(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { stream ->
      val buf = ByteArray(1 shl 20)
      while (true) {
        val n = stream.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return md.digest().joinToString("") { "%02x".format(it) }
  }

  /** A small GET with timeouts. `URL.readText()` has none and can hang for minutes. */
  private fun get(url: String): String {
    val conn = (URL(url).openConnection() as HttpURLConnection).apply {
      connectTimeout = CONNECT_TIMEOUT_MS
      readTimeout = READ_TIMEOUT_MS
    }
    try {
      if (conn.responseCode != HttpURLConnection.HTTP_OK) {
        throw IOException("HTTP ${conn.responseCode} for $url")
      }
      return conn.inputStream.bufferedReader().readText()
    } finally {
      conn.disconnect()
    }
  }

  private fun throwIfCancelled() {
    if (cancelled) throw DownloadCancelled()
  }
}
