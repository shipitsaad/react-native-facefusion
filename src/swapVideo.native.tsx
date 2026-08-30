import Facefusion from './NativeFacefusion';
import type { EventSubscription } from 'react-native';
import type {
  SwapOptions,
  SwapVideoResult,
  VideoSwapProgress,
} from './NativeFacefusion';

/**
 * Swaps the face from `sourcePath` into every frame of the video at `targetPath`, writing
 * the result to `outputPath`.
 *
 * Runs behind a foreground service — Android kills a plain background process partway
 * through a job this long. Rejects with `E_BUSY` if a photo or another video swap is
 * already running, `E_MODELS` if the required models are not downloaded yet, `E_CANCELLED`
 * if `cancelVideoSwap()` was called, and `E_SWAP` for anything else, naming what failed.
 */
export function swapVideo(
  sourcePath: string,
  targetPath: string,
  outputPath: string,
  options?: SwapOptions
): Promise<SwapVideoResult> {
  return Facefusion.swapVideo(sourcePath, targetPath, outputPath, options);
}

/** Asks the video swap in flight to stop. Fire-and-forget — see `swapVideo`'s doc. */
export function cancelVideoSwap(): void {
  Facefusion.cancelVideoSwap();
}

/**
 * Subscribe to video swap progress. Returns the subscription — call `.remove()` on
 * unmount.
 */
export function onVideoSwapProgress(
  listener: (progress: VideoSwapProgress) => void
): EventSubscription {
  return Facefusion.onVideoSwapProgress(listener);
}
