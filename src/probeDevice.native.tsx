import Facefusion from './NativeFacefusion';
import type { DeviceProbeResult } from './NativeFacefusion';

/**
 * Ask the device which NPU it has and which model tier it needs.
 *
 * Cheap enough to call on startup, and safe on hardware that has no NPU at all — it
 * resolves with `ok: false` rather than rejecting. It rejects only when the native
 * library itself is missing or unloadable.
 */
export function probeDevice(): Promise<DeviceProbeResult> {
  return Facefusion.probeDevice();
}
