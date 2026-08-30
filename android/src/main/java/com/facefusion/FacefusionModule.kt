package com.facefusion

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facefusion.mobile.NativePipe
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

class FacefusionModule(reactContext: ReactApplicationContext) :
  NativeFacefusionSpec(reactContext) {

  // One thread, not a pool. The native pipeline is a single C++ global (`g_pipe`) and is
  // not reentrant, so serialising every native call through one thread is the behaviour
  // we want anyway -- and it keeps the QNN backend's dlopen off the UI thread.
  private val worker = named("facefusion-native")

  // The downloader gets its OWN thread, and this is not an optimisation. A model download
  // is minutes long; if it shared `worker`, a probeDevice() call made while it ran would
  // queue behind it and look like a hang. It is safe to separate precisely because
  // downloading touches no native state at all -- it is HTTP and disk. The one native
  // answer it needs (the tier chain) is fetched back on `worker`, via [onWorker].
  private val downloader = named("facefusion-download")

  // A second concurrent download would fight the first over the same `.part` files. The
  // check is here rather than in ModelDownload so the rejection is immediate and typed.
  private val downloading = AtomicBoolean(false)

  override fun multiply(a: Double, b: Double): Double {
    return a * b
  }

  override fun probeDevice(promise: Promise) {
    worker.execute {
      try {
        promise.resolve(toMap(DeviceProbe.probe(reactApplicationContext)))
      } catch (e: Throwable) {
        // Includes UnsatisfiedLinkError: a JNI symbol that did not bind is an Error, not
        // an Exception, so `catch (e: Exception)` would let it kill the worker thread
        // and leave the promise pending forever.
        promise.reject("E_PROBE", e.message ?: e.toString(), e)
      }
    }
  }

  override fun getModelStatus(promise: Promise) {
    // On `worker`: resolving the tier reads the cached chain, and filling that cache is a
    // native call the first time.
    worker.execute {
      try {
        promise.resolve(modelStatus())
      } catch (e: Throwable) {
        promise.reject("E_MODEL_STATUS", e.message ?: e.toString(), e)
      }
    }
  }

  override fun downloadModels(promise: Promise) {
    if (!downloading.compareAndSet(false, true)) {
      promise.reject("E_BUSY", "A model download is already running")
      return
    }
    downloader.execute {
      try {
        val chain = onWorker { DeviceProbe.tierChain(reactApplicationContext) }
        ModelDownload.run(ModelPaths.dir(reactApplicationContext), chain) { progress ->
          emitOnModelDownloadProgress(toMap(progress))
        }
        // Resolve with the status rather than the tier: the caller's next question is
        // always "can it run now", and answering it here saves a round trip.
        promise.resolve(onWorker { modelStatus() })
      } catch (e: DownloadCancelled) {
        promise.reject("E_CANCELLED", e.message ?: "Cancelled", e)
      } catch (e: Throwable) {
        promise.reject("E_DOWNLOAD", e.message ?: e.toString(), e)
      } finally {
        downloading.set(false)
      }
    }
  }

  override fun swapPhoto(
    sourcePath: String,
    targetPath: String,
    outputPath: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    worker.execute {
      try {
        val result = PhotoSwap.run(
          reactApplicationContext, sourcePath, targetPath, outputPath, swapConfig(options)
        )
        promise.resolve(toMap(result))
      } catch (e: PipeGuard.Busy) {
        promise.reject("E_BUSY", e.message, e)
      } catch (e: PhotoSwap.ModelsMissing) {
        promise.reject("E_MODELS", e.message, e)
      } catch (e: Throwable) {
        // Includes UnsatisfiedLinkError -- see the same note on probeDevice() above.
        promise.reject("E_SWAP", e.message ?: e.toString(), e)
      }
    }
  }

  override fun cancelModelDownload() {
    // Deliberately not a promise. Cancelling is a flag the download loop reads; the answer
    // the caller wants -- that it stopped -- arrives as the E_CANCELLED rejection of
    // downloadModels(), not from here.
    ModelDownload.cancel()
  }

  override fun invalidate() {
    ModelDownload.cancel()
    NativePipe.release()
    worker.shutdown()
    downloader.shutdown()
    super.invalidate()
  }

  /** Runs [block] on the native worker and waits. Safe: `worker` never waits on `downloader`. */
  private fun <T> onWorker(block: () -> T): T = worker.submit(Callable(block)).get()

  private fun modelStatus(): WritableMap {
    val context = reactApplicationContext
    val tier = ModelPaths.tier(context)
    val missing = ModelPaths.missing(context, tier)

    return Arguments.createMap().apply {
      putString("tier", tier)
      putArray("tierChain", stringsOf(DeviceProbe.tierChain(context)))
      putString("dir", ModelPaths.dir(context).absolutePath)
      putBoolean("ready", missing.isEmpty())
      putArray("missing", stringsOf(missing))
      putBoolean("hasEnhancer", ModelPaths.hasEnhancer(context, tier))
      putBoolean("metered", ModelDownload.isMetered(context))
    }
  }

  /** `options` from JS, defaulted field by field against [SwapConfig]'s own defaults. */
  private fun swapConfig(options: ReadableMap?): SwapConfig {
    val defaults = SwapConfig()
    if (options == null) return defaults
    return SwapConfig(
      swapperWeight = optDouble(options, "swapperWeight")?.toFloat() ?: defaults.swapperWeight,
      maskBlur = optDouble(options, "maskBlur")?.toFloat() ?: defaults.maskBlur,
      maskPadding = if (options.hasKey("maskPadding") && !options.isNull("maskPadding")) {
        val arr = options.getArray("maskPadding")
        (0 until (arr?.size() ?: 0)).map { arr!!.getInt(it) }
      } else defaults.maskPadding,
      detectorScore = optDouble(options, "detectorScore")?.toFloat() ?: defaults.detectorScore,
      landmarkerScore = optDouble(options, "landmarkerScore")?.toFloat() ?: defaults.landmarkerScore,
      pixelBoost = if (options.hasKey("pixelBoost") && !options.isNull("pixelBoost")) {
        options.getInt("pixelBoost")
      } else defaults.pixelBoost,
      largestFaceOnly = if (options.hasKey("largestFaceOnly") && !options.isNull("largestFaceOnly")) {
        options.getBoolean("largestFaceOnly")
      } else defaults.largestFaceOnly,
      faceEnhance = if (options.hasKey("faceEnhance") && !options.isNull("faceEnhance")) {
        options.getBoolean("faceEnhance")
      } else defaults.faceEnhance,
      faceEnhancerBlend = optDouble(options, "faceEnhancerBlend")?.toFloat() ?: defaults.faceEnhancerBlend,
    )
  }

  private fun optDouble(options: ReadableMap, key: String): Double? =
    if (options.hasKey(key) && !options.isNull(key)) options.getDouble(key) else null

  private fun toMap(result: PhotoSwapResult): WritableMap = Arguments.createMap().apply {
    putString("outputPath", result.outputPath)
    putInt("faceCount", result.faceCount)
    putString("tier", result.tier)
  }

  private fun toMap(progress: DownloadProgress): WritableMap = Arguments.createMap().apply {
    putString("tier", progress.tier)
    putInt("fileIndex", progress.fileIndex)
    putInt("fileCount", progress.fileCount)
    putString("name", progress.name)
    // Double, not Int: these run to ~317 million and Arguments has no Long. A double holds
    // every integer up to 2^53 exactly, so the byte counts are precise.
    putDouble("doneBytes", progress.doneBytes.toDouble())
    putDouble("totalBytes", progress.totalBytes.toDouble())
  }

  private fun toMap(probe: DeviceProbe): WritableMap = Arguments.createMap().apply {
    putBoolean("ok", probe.ok)
    putString("tier", probe.tier)
    putArray("tierChain", stringsOf(probe.tierChain))
    putInt("arch", probe.arch)
    putInt("vtcmMb", probe.vtcmMb)
    putInt("socModel", probe.socModel)
    putBoolean("signedPd", probe.signedPd)
    putBoolean("dlbc", probe.dlbc)
    putString("error", probe.error)
  }

  private fun stringsOf(values: List<String>) = Arguments.createArray().apply {
    values.forEach { pushString(it) }
  }

  companion object {
    const val NAME = NativeFacefusionSpec.NAME

    private fun named(name: String): ExecutorService =
      Executors.newSingleThreadExecutor { r -> Thread(r, name).apply { isDaemon = true } }
  }
}
