import Facefusion from './NativeFacefusion';

export function acknowledgeUsagePolicy(): Promise<void> {
  return Facefusion.acknowledgeUsagePolicy();
}
