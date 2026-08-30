import type { SwapOptions, SwapPhotoResult } from './NativeFacefusion';

export function swapPhoto(
  _sourcePath: string,
  _targetPath: string,
  _outputPath: string,
  _options?: SwapOptions
): Promise<SwapPhotoResult> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}
