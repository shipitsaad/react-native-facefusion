import Facefusion from './NativeFacefusion';

/**
 * Copies a `swapPhoto`/`swapVideo` output into the system's Photos/Gallery app, so it
 * survives beyond this app's own private storage. Returns the resulting `content://` URI.
 *
 * `mimeType` must be `image/*` or `video/*` — pass the real one, there's no safe way to
 * guess it from a path alone. No storage permission is needed on Android.
 */
export function saveToGallery(
  path: string,
  mimeType: string,
  displayName?: string
): Promise<string> {
  return Facefusion.saveToGallery(path, mimeType, displayName);
}
