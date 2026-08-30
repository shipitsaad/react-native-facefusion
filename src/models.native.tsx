import Facefusion from './NativeFacefusion';
import type { EventSubscription } from 'react-native';
import type { ModelStatus, ModelDownloadProgress } from './NativeFacefusion';

/**
 * What is on disk and whether a swap could run right now. Reads the filesystem only —
 * no network, cheap enough to call whenever a screen appears.
 */
export function getModelStatus(): Promise<ModelStatus> {
  return Facefusion.getModelStatus();
}

/**
 * Download every model this device still needs, resolving with the resulting status.
 *
 * ~317 MB on a fresh install, and minutes on a phone connection. Resumable: an interrupted
 * run leaves `.part` files and calling this again continues from where it stopped, so a
 * retry after a dropped connection is cheap. Files already present and the right size are
 * skipped, so calling it when everything is downloaded costs one manifest request.
 *
 * Rejects with `E_CANCELLED` after {@link cancelModelDownload}, `E_BUSY` if a download is
 * already running, and `E_DOWNLOAD` naming the file that failed otherwise.
 */
export function downloadModels(): Promise<ModelStatus> {
  return Facefusion.downloadModels();
}

/**
 * Stop the download in flight. The promise from {@link downloadModels} rejects with
 * `E_CANCELLED`; partial files are kept for a later resume.
 */
export function cancelModelDownload(): void {
  Facefusion.cancelModelDownload();
}

/**
 * Subscribe to download progress. Emits about four times a second while a download runs.
 *
 * Returns the subscription — call `.remove()` on unmount.
 */
export function onModelDownloadProgress(
  listener: (progress: ModelDownloadProgress) => void
): EventSubscription {
  return Facefusion.onModelDownloadProgress(listener);
}
