import {
  TurboModuleRegistry,
  type CodegenTypes,
  type TurboModule,
} from 'react-native';

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

/**
 * What is on disk, and what the pipeline would load right now.
 *
 * `tier` is resolved against the **files present**, not against the chip: a phone whose
 * best architecture has no published models runs the best tier that does. So this can
 * legitimately differ from `DeviceProbeResult.tier`, and this is the one that matters for
 * "can it run".
 */
export type ModelStatus = {
  /** The tier that will actually be loaded — best tier whose files are on disk. */
  tier: string;
  /** Every tier this chip could load, best first. */
  tierChain: string[];
  /** Absolute path of the models directory. */
  dir: string;
  /** True when every model the pipeline requires is present and verified. */
  ready: boolean;
  /** Base names of the required models still absent, e.g. `['hyperswap', 'nsfw']`. */
  missing: string[];
  /** Whether the optional face enhancer (`gpen`) is present. */
  hasEnhancer: boolean;
  /** True when the current connection is metered — worth a warning before ~317 MB. */
  metered: boolean;
};

/** A download in flight. Byte counts are across the whole set, not the current file. */
export type ModelDownloadProgress = {
  /** The tier being fetched. May differ from the chip's best tier — see [ModelStatus]. */
  tier: string;
  /** 1-based index of the file being fetched, of `fileCount`. */
  fileIndex: number;
  /** How many files this run has to fetch. Already-present files are not counted. */
  fileCount: number;
  /** File name being fetched, e.g. `hyperswap_v79.bin`. Empty on the final tick. */
  name: string;
  /** Bytes transferred so far across the run, including a resumed `.part`. */
  doneBytes: number;
  /** Bytes this run has to transfer in total. */
  totalBytes: number;
};

export interface Spec extends TurboModule {
  multiply(a: number, b: number): number;
  probeDevice(): Promise<DeviceProbeResult>;
  getModelStatus(): Promise<ModelStatus>;
  downloadModels(): Promise<ModelStatus>;
  cancelModelDownload(): void;
  readonly onModelDownloadProgress: CodegenTypes.EventEmitter<ModelDownloadProgress>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Facefusion');
