import Facefusion from './NativeFacefusion';
import type { DetectedFace } from './NativeFacefusion';

/**
 * Every face detected in the photo at `sourcePath`, for a UI to let the user pick one
 * before swapping — pass the chosen face's box back as `sourceFaceBox` in `SwapOptions`.
 * Does not swap or modify anything.
 *
 * Rejects with `E_BUSY` if a swap or video job is already running, `E_MODELS` if the
 * required models are not on disk yet, and `E_DETECT` otherwise.
 */
export function detectSourceFaces(sourcePath: string): Promise<DetectedFace[]> {
  return Facefusion.detectSourceFaces(sourcePath);
}
