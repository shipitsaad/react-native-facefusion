package facefusion.example

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.io.FileOutputStream

/**
 * Example-app-only testing convenience — NOT part of the `react-native-facefusion` library.
 * Typing an `adb push`ed path into a text field works but is painful to iterate on, so this
 * opens Android's document picker and hands JS back a real filesystem path.
 *
 * The picker returns a `content://` Uri, not a path, and the native swap pipeline reads files
 * by absolute path (`BitmapFactory.decodeFile`, `MediaExtractor.setDataSource(String)`) — so
 * the picked file is copied into this app's own external-files dir, the same
 * permission-free directory `ModelPaths`/`PhotoSwap` in the library already use. That copy is
 * what makes this necessary rather than merely convenient: there is no path to hand back
 * without it, only a Uri our native code cannot open.
 *
 * `ACTION_OPEN_DOCUMENT` itself needs no storage permission — the Storage Access Framework
 * grants read access to the one Uri the user picked regardless. `READ_MEDIA_IMAGES` /
 * `READ_MEDIA_VIDEO` are requested from the JS side anyway (App.tsx) before this is called,
 * because Saad asked for the storage-permission path explicitly; it costs nothing extra here.
 */
class MediaPickerModule(reactContext: ReactApplicationContext) :
  ReactContextBaseJavaModule(reactContext) {

  override fun getName() = "MediaPicker"

  private var pendingPromise: Promise? = null
  private var pendingExtension = "jpg"

  private val activityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(
      activity: Activity,
      requestCode: Int,
      resultCode: Int,
      data: Intent?,
    ) {
      if (requestCode != REQUEST_CODE) return
      val promise = pendingPromise ?: return
      pendingPromise = null

      val uri = data?.data
      if (resultCode != Activity.RESULT_OK || uri == null) {
        promise.reject("E_CANCELLED", "No file selected")
        return
      }
      try {
        promise.resolve(copyToAppStorage(uri))
      } catch (e: Throwable) {
        promise.reject("E_PICK", e.message ?: e.toString(), e)
      }
    }
  }

  init {
    reactContext.addActivityEventListener(activityEventListener)
  }

  /**
   * `kind` is `"image"`, `"video"`, or `"media"` for either.
   *
   * `"media"` is what the app actually uses now: the target of a swap can be a photo or a
   * clip, and making the user declare which one BEFORE the picker opens is a choice they
   * should never have had to make -- they know what they want to swap, not which of two
   * buttons the app wants them to press first. With either allowed, the extension can no
   * longer be assumed up front and comes from what was really picked instead.
   */
  @ReactMethod
  fun pickMedia(kind: String, promise: Promise) {
    val activity = reactApplicationContext.currentActivity
    if (activity == null) {
      promise.reject("E_NO_ACTIVITY", "No current activity to launch the picker from")
      return
    }
    pendingPromise = promise
    pendingExtension = if (kind == "video") "mp4" else "jpg"

    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      when (kind) {
        "video" -> type = "video/*"
        "image" -> type = "image/*"
        else -> {
          // ACTION_OPEN_DOCUMENT takes ONE `type`; two are expressed as `*/*` narrowed by
          // EXTRA_MIME_TYPES, which the picker uses to filter. Without the extra, `*/*`
          // would offer PDFs and zips for a face swap.
          type = "*/*"
          putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("image/*", "video/*"))
        }
      }
    }
    activity.startActivityForResult(intent, REQUEST_CODE)
  }

  private fun copyToAppStorage(uri: Uri): String {
    val dir = reactApplicationContext.getExternalFilesDir(null)
      ?: reactApplicationContext.filesDir
    val dest = File(dir, "picked_${System.currentTimeMillis()}.${extensionFor(uri)}")
    val input = reactApplicationContext.contentResolver.openInputStream(uri)
      ?: throw IllegalStateException("Could not open the picked file")
    input.use { stream -> FileOutputStream(dest).use { out -> stream.copyTo(out) } }
    return dest.absolutePath
  }

  /**
   * The copied file's extension, from the Uri's real MIME type rather than from what the
   * caller asked for. This is load-bearing, not tidiness: JS decides photo-vs-video by
   * looking at the extension, so a clip copied out as `.jpg` would be sent to the photo
   * swap and fail to decode.
   */
  private fun extensionFor(uri: Uri): String {
    val mime = reactApplicationContext.contentResolver.getType(uri)
      ?: return pendingExtension
    val fromMap = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)
    if (fromMap != null) return fromMap
    return if (mime.startsWith("video/")) "mp4" else "jpg"
  }

  companion object {
    private const val REQUEST_CODE = 9821
  }
}
