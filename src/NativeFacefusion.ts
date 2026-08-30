import { TurboModuleRegistry, type TurboModule } from 'react-native';

/**
 * What the device's Hexagon NPU reports about itself.
 *
 * `ok` is the field that decides whether the rest mean anything. `false` means the probe
 * could not run — no Qualcomm NPU, no QNN runtime, an emulator — and *not* that the chip
 * is too old. `tier` and `tierChain` are still usable in that case: they fall back to
 * `v68`, the build that runs on every Hexagon.
 */
export type DeviceProbeResult = {
  /** True only when the NPU was actually measured. */
  ok: boolean;
  /** The context-binary tier this chip should download — `v68` … `v81`. */
  tier: string;
  /** Every tier that would load here, best first. The downloader wants this one. */
  tierChain: string[];
  /** Hexagon architecture number: 68, 73, 79, 81. `0` when unmeasured. */
  arch: number;
  /** Tightly-coupled memory in MB. The v73/v79/v81 builds need 8. */
  vtcmMb: number;
  /** Qualcomm's SoC id — 69 is SM8750, the 8 Elite. */
  socModel: number;
  signedPd: boolean;
  dlbc: boolean;
  /** Why the probe failed. Empty when `ok`. */
  error: string;
};

export interface Spec extends TurboModule {
  multiply(a: number, b: number): number;
  probeDevice(): Promise<DeviceProbeResult>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Facefusion');
