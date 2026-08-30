import type { DetectedFace } from './NativeFacefusion';

export function detectTargetFaces(
  _targetPath: string
): Promise<DetectedFace[]> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}
