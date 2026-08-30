package facefusion.example

import android.app.Activity
import android.content.Intent
import android.net.Uri
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

  /** `kind` is `"image"` or `"video"`. Resolves with the copied file's absolute path. */
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
      type = if (kind == "video") "video/*" else "image/*"
    }
    activity.startActivityForResult(intent, REQUEST_CODE)
  }

  private fun copyToAppStorage(uri: Uri): String {
    val dir = reactApplicationContext.getExternalFilesDir(null)
      ?: reactApplicationContext.filesDir
    val dest = File(dir, "picked_${System.currentTimeMillis()}.$pendingExtension")
    val input = reactApplicationContext.contentResolver.openInputStream(uri)
      ?: throw IllegalStateException("Could not open the picked file")
    input.use { stream -> FileOutputStream(dest).use { out -> stream.copyTo(out) } }
    return dest.absolutePath
  }

  companion object {
    private const val REQUEST_CODE = 9821
  }
}
