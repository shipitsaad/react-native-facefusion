package com.facefusion

import android.content.ContentValues
import android.content.Context
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Copies a swap's output into the system's Photos/Gallery app, so it survives beyond this
 * app's own private storage (where [PhotoSwap]/[VideoSwap] actually write) and shows up
 * somewhere other apps and the user's own Files/Photos app can see it.
 *
 * This is deliberately a separate, stateless call rather than something `swapPhoto`/
 * `swapVideo` do automatically — same reasoning as `sourceFaceBox`/`targetFaceBox` staying
 * out of [SwapConfig] (ADR-0012/0014): "write the output" and "publish it to the gallery"
 * are two different decisions, and a caller who wants the first without the second
 * shouldn't have to work around the second happening anyway.
 */
object GallerySave {

  /** [mimeType] was neither an image nor a video mime type — nothing else is a supported
   *  gallery collection on Android. */
  class UnsupportedMimeType(message: String) : Exception(message)

  /**
   * Copies the file at [sourcePath] into `MediaStore.Images` or `MediaStore.Video`,
   * depending on [mimeType], under a `Facefusion` album inside Pictures or Movies. Returns
   * the resulting `content://` URI as a string.
   *
   * No storage permission is needed here, on `minSdk 31` or any API level since scoped
   * storage arrived (29): inserting *new* media an app itself created into MediaStore has
   * never required one — only reading or modifying media the app didn't create does. That
   * is also why this can't just be a plain file copy to `/sdcard/Pictures` — an app has no
   * direct filesystem access to another app's (or the Gallery's) view of shared storage,
   * `MediaStore` is the only door in.
   */
  fun run(
    context: Context,
    sourcePath: String,
    mimeType: String,
    displayName: String,
  ): String {
    val source = File(sourcePath)
    require(source.exists()) { "No file at $sourcePath" }

    val (collection, relativeDir) = when {
      mimeType.startsWith("image/") ->
        MediaStore.Images.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_PICTURES
      mimeType.startsWith("video/") ->
        MediaStore.Video.Media.EXTERNAL_CONTENT_URI to Environment.DIRECTORY_MOVIES
      else -> throw UnsupportedMimeType(
        "saveToGallery supports image/* and video/* only, got '$mimeType'"
      )
    }

    val resolver = context.contentResolver

    // IS_PENDING hides the row from other apps (the Gallery included) until the bytes are
    // actually written -- without it, something could show a zero-byte or half-written file
    // for the brief window between insert() and the copy finishing.
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
      put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
      put(MediaStore.MediaColumns.RELATIVE_PATH, "$relativeDir/Facefusion")
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }

    val uri = resolver.insert(collection, values)
      ?: throw IllegalStateException("MediaStore refused to insert $displayName")

    val opened = resolver.openOutputStream(uri)
      ?: throw IllegalStateException("Could not open an output stream for $uri")
    opened.use { out -> source.inputStream().use { it.copyTo(out) } }

    values.clear()
    values.put(MediaStore.MediaColumns.IS_PENDING, 0)
    resolver.update(uri, values, null, null)

    return uri.toString()
  }
}
