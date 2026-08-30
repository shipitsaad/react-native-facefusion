import type { EventSubscription } from 'react-native';
import type {
  SwapOptions,
  SwapVideoResult,
  VideoSwapProgress,
} from './NativeFacefusion';

export function swapVideo(
  _sourcePath: string,
  _targetPath: string,
  _outputPath: string,
  _options?: SwapOptions
): Promise<SwapVideoResult> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}

export function cancelVideoSwap(): void {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}

export function onVideoSwapProgress(
  _listener: (progress: VideoSwapProgress) => void
): EventSubscription {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}
