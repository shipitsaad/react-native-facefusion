import type { DetectedFace } from './NativeFacefusion';

export function detectSourceFaces(
  _sourcePath: string
): Promise<DetectedFace[]> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}
