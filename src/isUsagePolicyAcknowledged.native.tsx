import Facefusion from './NativeFacefusion';

export function isUsagePolicyAcknowledged(): Promise<boolean> {
  return Facefusion.isUsagePolicyAcknowledged();
}
