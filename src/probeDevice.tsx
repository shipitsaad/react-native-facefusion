import type { DeviceProbeResult } from './NativeFacefusion';

export function probeDevice(): Promise<DeviceProbeResult> {
  throw new Error(
    "'react-native-facefusion' is only supported on native platforms."
  );
}
