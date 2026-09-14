import type { DetectedFace, DetectOptions } from './NativeFacefusion';

export function detectTargetFaces(
  _targetPath: string,
  _options?: DetectOptions
): Promise<DetectedFace[]> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}
