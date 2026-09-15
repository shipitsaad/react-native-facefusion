package com.facefusion

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.bridge.WritableMap
import com.facefusion.mobile.NativePipe
import java.io.File
import java.util.concurrent.Callable
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
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

  // A THIRD thread, for the same reason `downloader` is separate from `worker`: a video
  // swap is minutes long, and if it shared `worker` a probeDevice()/getModelStatus() call
  // made mid-swap would silently queue behind it. It is not safe to fold into `downloader`
  // either -- unlike a download, a video job DOES touch the native pipeline throughout, via
  // PipeGuard, which is the actual cross-job mutual exclusion. This executor only keeps
  // unrelated lightweight calls responsive while it runs.
  private val videoWorker = named("facefusion-video")

  // Checked synchronously in swapVideo() before dispatch. Without it, a second call would
  // silently queue behind the first on `videoWorker` (a single-thread executor) and only
  // get rejected by PipeGuard.Busy once it started running, minutes later -- this fails
  // fast instead, the same shape as `downloading` above.
  private val videoBusy = AtomicBoolean(false)

  // Its own thread for the same reason `downloader` is separate from `worker`: a gallery
  // save touches no native state at all, just MediaStore + a file copy, so it must not queue
  // behind a slow swap or a model download that happen to be running on their own threads.
  private val gallery = named("facefusion-gallery")

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
          reactApplicationContext, sourcePath, targetPath, outputPath, swapConfig(options),
          sourceFaceBox(options), targetFaceBox(options),
        )
        promise.resolve(toMap(result))
      } catch (e: PipeGuard.Busy) {
        promise.reject("E_BUSY", e.message, e)
      } catch (e: PhotoSwap.ModelsMissing) {
        promise.reject("E_MODELS", e.message, e)
      } catch (e: ContentGate.Refused) {
        promise.reject("E_CONTENT", e.message, e)
      } catch (e: Throwable) {
        // Includes UnsatisfiedLinkError -- see the same note on probeDevice() above.
        promise.reject("E_SWAP", e.message ?: e.toString(), e)
      }
    }
  }

  override fun detectSourceFaces(sourcePath: String, options: ReadableMap?, promise: Promise) {
    // On `worker`, same as swapPhoto -- a single-image detect pass is fast enough that it
    // doesn't need its own thread the way the minutes-long video job does.
    worker.execute {
      try {
        val faces = SourceFaces.detect(reactApplicationContext, sourcePath, swapConfig(options))
        promise.resolve(facesArray(faces))
      } catch (e: PipeGuard.Busy) {
        promise.reject("E_BUSY", e.message, e)
      } catch (e: SourceFaces.ModelsMissing) {
        promise.reject("E_MODELS", e.message, e)
      } catch (e: Throwable) {
        promise.reject("E_DETECT", e.message ?: e.toString(), e)
      }
    }
  }

  override fun detectTargetFaces(targetPath: String, options: ReadableMap?, promise: Promise) {
    worker.execute {
      try {
        val faces = TargetFaces.detect(reactApplicationContext, targetPath, swapConfig(options))
        promise.resolve(facesArray(faces))
      } catch (e: PipeGuard.Busy) {
        promise.reject("E_BUSY", e.message, e)
      } catch (e: TargetFaces.ModelsMissing) {
        promise.reject("E_MODELS", e.message, e)
      } catch (e: Throwable) {
        promise.reject("E_DETECT", e.message ?: e.toString(), e)
      }
    }
  }

  override fun swapVideo(
    sourcePath: String,
    targetPath: String,
    outputPath: String,
    options: ReadableMap?,
    promise: Promise,
  ) {
    if (!videoBusy.compareAndSet(false, true)) {
      promise.reject("E_BUSY", "A video swap is already running")
      return
    }
    videoWorker.execute {
      try {
        // Must be inside the try: on minSdk 31+, starting a foreground service from
        // outside a foreground/allowed context throws
        // ForegroundServiceStartNotAllowedException. Outside this try that exception had
        // nowhere to go but off this Runnable entirely -- `promise` never settled (the JS
        // call hung forever) and the `finally` below never ran, so `videoBusy` stayed
        // `true` and every later swapVideo() call rejected E_BUSY for the rest of the
        // process's life.
        VideoSwapService.start(reactApplicationContext)
        val result = VideoSwap.run(
          reactApplicationContext, sourcePath, targetPath, outputPath, swapConfig(options),
          sourceFaceBox(options), targetFaceBox(options), targetFps(options),
        ) { progress ->
          VideoSwapService.updateProgress(
            reactApplicationContext, "Swapping video… ${progress.frameIndex} frames"
          )
          emitOnVideoSwapProgress(toMap(progress))
        }
        promise.resolve(toMap(result))
      } catch (e: PipeGuard.Busy) {
        promise.reject("E_BUSY", e.message, e)
      } catch (e: VideoSwap.ModelsMissing) {
        promise.reject("E_MODELS", e.message, e)
      } catch (e: VideoSwap.Cancelled) {
        promise.reject("E_CANCELLED", e.message ?: "Cancelled", e)
      } catch (e: ContentGate.Refused) {
        promise.reject("E_CONTENT", e.message, e)
      } catch (e: Throwable) {
        // Includes UnsatisfiedLinkError -- see the same note on probeDevice() above.
        promise.reject("E_SWAP", e.message ?: e.toString(), e)
      } finally {
        videoBusy.set(false)
        VideoSwapService.stop(reactApplicationContext)
      }
    }
  }

  override fun saveToGallery(
    path: String,
    mimeType: String,
    displayName: String?,
    promise: Promise,
  ) {
    gallery.execute {
      try {
        val name = displayName ?: File(path).name
        val uri = GallerySave.run(reactApplicationContext, path, mimeType, name)
        promise.resolve(uri)
      } catch (e: GallerySave.UnsupportedMimeType) {
        promise.reject("E_MIME", e.message, e)
      } catch (e: Throwable) {
        promise.reject("E_SAVE", e.message ?: e.toString(), e)
      }
    }
  }

  override fun cancelVideoSwap() {
    // Deliberately not a promise -- see cancelModelDownload() below for why.
    VideoSwap.cancel()
  }

  override fun cancelModelDownload() {
    // Deliberately not a promise. Cancelling is a flag the download loop reads; the answer
    // the caller wants -- that it stopped -- arrives as the E_CANCELLED rejection of
    // downloadModels(), not from here.
    ModelDownload.cancel()
  }

  override fun invalidate() {
    // Cooperative cancellation first, so anything already running on `worker`/`videoWorker`
    // gets to the next `throwIfCancelled()` check and exits quickly instead of running its
    // full course.
    ModelDownload.cancel()
    VideoSwap.cancel()

    // `shutdown()` alone only stops NEW submissions -- a processFrame()/initEx() call
    // already in flight keeps running on its own thread afterwards. `NativePipe.release()`
    // used to run right after `shutdown()` with nothing in between, so a job that was
    // mid-call when the module got invalidated (a JS reload while a swap is running, say)
    // could still be touching `g_pipe` in native code the instant it was freed -- a
    // use-after-free, which shows up as a native crash, not a catchable Kotlin exception.
    // Waiting for real termination first closes that gap; the two executors that never
    // touch `g_pipe` (`downloader`, `gallery`) don't need the same wait.
    worker.shutdown()
    videoWorker.shutdown()
    downloader.shutdown()
    gallery.shutdown()
    worker.awaitTermination(10, TimeUnit.SECONDS)
    videoWorker.awaitTermination(10, TimeUnit.SECONDS)

    NativePipe.release()
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

  /** `sourceFaceBox` from `options` -- not part of [swapConfig]/[SwapConfig] because it
   *  never reaches `initEx`; it only decides what [PhotoSwap]/[VideoSwap] crop before
   *  calling the unchanged `setSource`. See [SourceFaces]. */
  private fun sourceFaceBox(options: ReadableMap?): FloatArray? {
    if (options == null || !options.hasKey("sourceFaceBox") || options.isNull("sourceFaceBox")) {
      return null
    }
    val arr = options.getArray("sourceFaceBox") ?: return null
    require(arr.size() == 4) { "sourceFaceBox must be [left, top, right, bottom]" }
    return FloatArray(4) { i -> arr.getDouble(i).toFloat() }
  }

  /** `targetFaceBox` from `options` -- mirrors [sourceFaceBox] above; see [FaceCrop]. */
  private fun targetFaceBox(options: ReadableMap?): FloatArray? {
    if (options == null || !options.hasKey("targetFaceBox") || options.isNull("targetFaceBox")) {
      return null
    }
    val arr = options.getArray("targetFaceBox") ?: return null
    require(arr.size() == 4) { "targetFaceBox must be [left, top, right, bottom]" }
    return FloatArray(4) { i -> arr.getDouble(i).toFloat() }
  }

  /** `targetFps` from `options` -- not part of [swapConfig]/[SwapConfig] because it never
   *  reaches `initEx`; it only decides which decoded frames [VideoSwap] bothers swapping. */
  private fun targetFps(options: ReadableMap?): Int? {
    if (options == null || !options.hasKey("targetFps") || options.isNull("targetFps")) {
      return null
    }
    return options.getDouble("targetFps").toInt()
  }

  private fun facesArray(faces: List<DetectedFace>) = Arguments.createArray().apply {
    faces.forEach { f ->
      pushMap(
        Arguments.createMap().apply {
          putDouble("left", f.left.toDouble())
          putDouble("top", f.top.toDouble())
          putDouble("right", f.right.toDouble())
          putDouble("bottom", f.bottom.toDouble())
          putDouble("score", f.score.toDouble())
          // The box's coordinate space. Not derivable by the caller: the analysed
          // bitmap is capped for photos and uncapped for video frames -- see DetectedFace.
          putInt("imageWidth", f.imageWidth)
          putInt("imageHeight", f.imageHeight)
        }
      )
    }
  }

  private fun toMap(result: PhotoSwapResult): WritableMap = Arguments.createMap().apply {
    putString("outputPath", result.outputPath)
    putInt("faceCount", result.faceCount)
    putString("tier", result.tier)
  }

  private fun toMap(result: VideoSwapResult): WritableMap = Arguments.createMap().apply {
    putString("outputPath", result.outputPath)
    putInt("frameCount", result.frameCount)
    putInt("faceFrameCount", result.faceFrameCount)
    putString("tier", result.tier)
    putDouble("fps", result.fps)
    putBoolean("hasAudio", result.hasAudio)
  }

  private fun toMap(progress: VideoSwapProgress): WritableMap = Arguments.createMap().apply {
    putInt("frameIndex", progress.frameIndex)
    putInt("estimatedFrameCount", progress.estimatedFrameCount)
    putDouble("fps", progress.fps)
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
