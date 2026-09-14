import Facefusion from './NativeFacefusion';
import type { DetectedFace, DetectOptions } from './NativeFacefusion';

/**
 * Every face detected in the target at `targetPath` — a photo, or a video (its first
 * frame, already upright) — for a UI to let the user pick one before swapping — pass the
 * chosen face's box back as `targetFaceBox` in `SwapOptions`. Does not swap or modify
 * anything.
 */
export function detectTargetFaces(
  targetPath: string,
  options?: DetectOptions
): Promise<DetectedFace[]> {
  return Facefusion.detectTargetFaces(targetPath, options);
}
