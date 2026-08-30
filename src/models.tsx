import type { EventSubscription } from 'react-native';
import type { ModelStatus, ModelDownloadProgress } from './NativeFacefusion';

const unsupported = () =>
  new Error("'react-native-facefusion' is only supported on native platforms.");

export function getModelStatus(): Promise<ModelStatus> {
  throw unsupported();
}

export function downloadModels(): Promise<ModelStatus> {
  throw unsupported();
}

export function cancelModelDownload(): void {
  throw unsupported();
}

export function onModelDownloadProgress(
  _listener: (progress: ModelDownloadProgress) => void
): EventSubscription {
  throw unsupported();
}
