import Facefusion from './NativeFacefusion';
import type { SwapOptions, SwapPhotoResult } from './NativeFacefusion';

/**
 * Swaps the face from `sourcePath` into every face found in `targetPath`, writing the
 * result to `outputPath`.
 *
 * Both images are decoded and re-encoded natively — nothing but paths and options crosses
 * the JS bridge. Rejects with `E_BUSY` if another swap (or, from Phase 7, a video job) is
 * already running, `E_MODELS` if the required models are not downloaded yet, and `E_SWAP`
 * for anything else, naming what failed.
 */
export function swapPhoto(
  sourcePath: string,
  targetPath: string,
  outputPath: string,
  options?: SwapOptions
): Promise<SwapPhotoResult> {
  return Facefusion.swapPhoto(sourcePath, targetPath, outputPath, options);
}
