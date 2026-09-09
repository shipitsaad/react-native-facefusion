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

/**
 * Tunable knobs for a swap. Every field is optional and defaults to upstream's own default
 * for the `hyperswap` swapper — see `ffpipe::Config` in the vendored C++.
 */
export type SwapOptions = {
  /** Blends the two identity embeddings before the generator sees them. 0.5 = source,
   *  unmodified; above it strengthens the source identity, below it blends the target's
   *  identity back in. Default `0.5`. */
  swapperWeight?: number;
  /** Softness of the paste-back mask edge, `0..1`. Default `0.3`. */
  maskBlur?: number;
  /** `[top, right, bottom, left]`, each `0..100` percent. Default `[0, 0, 0, 0]`. */
  maskPadding?: number[];
  /** Minimum detector confidence to count as a face, `0..1`. Default `0.5`. */
  detectorScore?: number;
  /** Minimum landmarker confidence, `0..1`. Default `0.5`. */
  landmarkerScore?: number;
  /** Per-axis upscale of the swap crop: 1 = 256px, 2 = 512px, 3 = 768px, 4 = 1024px. Costs
   *  `pixelBoost²` swapper invocations. Default `1`. */
  pixelBoost?: number;
  /** Swap only the largest face instead of every face found. Default `false`. */
  largestFaceOnly?: boolean;
  /** Run the face enhancer after swapping. Silently has no effect if the enhancer model is
   *  not on disk — check {@link ModelStatus.hasEnhancer} before offering this. Default
   *  `false`. */
  faceEnhance?: boolean;
  /** How much of the enhancer to blend in, `0..1`. `0` is the swapper's output untouched.
   *  Default `0.8`. */
  faceEnhancerBlend?: number;
  /**
   * Which face in the source photo to use as the identity, as `[left, top, right,
   * bottom]` from {@link detectSourceFaces} — in the source image's own pixel
   * coordinates, not normalised. Omit for the default: the largest face in the source,
   * same as every swap before this option existed.
   */
  sourceFaceBox?: number[];
  /**
   * Which face in the target to swap, as `[left, top, right, bottom]` from
   * {@link detectTargetFaces} — in the target's own pixel coordinates (for a video, the
   * clip's upright orientation). Omit to swap every face found (subject to
   * {@link SwapOptions.largestFaceOnly}), same as every swap before this option existed.
   * For a video, the box is picked once and held fixed for the whole clip — it is not
   * re-detected frame to frame, so a subject who moves far out of it stops being swapped.
   */
  targetFaceBox?: number[];
  /**
   * `swapVideo` only. Caps how many of the source's frames actually get swapped and
   * encoded — the rest are decoded and dropped, not held back or slowed down, so the
   * output plays at the same real-world duration, just choppier. Omit, or set `>=` the
   * source's own frame rate, to process every frame (default). Lowering this is a direct
   * wall-clock speed lever: half the frames is roughly half the NPU + encode work.
   */
  targetFps?: number;
};

/** One face found in a source photo, in the image's own pixel coordinates. */
export type DetectedFace = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** Detector confidence, `0..1`. */
  score: number;
};

/** The result of one still-photo swap. */
export type SwapPhotoResult = {
  /** Same as the `outputPath` passed in — returned for convenience. */
  outputPath: string;
  /** Faces found in the target. `0` means the swap ran but found nothing to swap, and
   *  `outputPath` is then an untouched copy of the target. */
  faceCount: number;
  /** The tier that ran — see {@link ModelStatus.tier}. */
  tier: string;
};

/** The result of one video swap. */
export type SwapVideoResult = {
  /** Same as the `outputPath` passed in — returned for convenience. */
  outputPath: string;
  /** Frames decoded, swapped and re-encoded — the real count. */
  frameCount: number;
  /** Of `frameCount`, how many had at least one face swapped. */
  faceFrameCount: number;
  /** The tier that ran — see {@link ModelStatus.tier}. */
  tier: string;
  /** Measured wall-clock frames/second across the decode-swap-encode loop. Not upstream's
   *  per-graph figure — see `docs/MEMORY.md` rule 11. */
  fps: number;
  /** Whether the source clip had an audio track — if so, it was copied to `outputPath`
   *  unmodified. */
  hasAudio: boolean;
};

/** A tick of progress through a video swap. */
export type VideoSwapProgress = {
  /** Frames decoded, swapped and encoded so far. */
  frameIndex: number;
  /** Estimated from the container's duration and frame rate. `0` when it could not be
   *  estimated — a variable-frame-rate source has no true count until the last frame. */
  estimatedFrameCount: number;
  /** Wall-clock frames/second so far. */
  fps: number;
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
  probeDevice(): Promise<DeviceProbeResult>;
  getModelStatus(): Promise<ModelStatus>;
  downloadModels(): Promise<ModelStatus>;
  cancelModelDownload(): void;
  readonly onModelDownloadProgress: CodegenTypes.EventEmitter<ModelDownloadProgress>;
  /**
   * Swaps the face from `sourcePath` into every face found in `targetPath`, writing the
   * result to `outputPath`. Paths in, path out — no pixels cross the bridge.
   *
   * Rejects with `E_BUSY` if a swap or video job is already running, `E_MODELS` if the
   * required models are not on disk yet, `E_CONTENT` if the target was refused by the
   * content gate, and `E_SWAP` otherwise.
   */
  swapPhoto(
    sourcePath: string,
    targetPath: string,
    outputPath: string,
    options?: SwapOptions
  ): Promise<SwapPhotoResult>;
  /**
   * Swaps the face from `sourcePath` into every frame of the video at `targetPath`,
   * writing the result to `outputPath`. Runs behind a foreground service (Android requires
   * one for a job this long) and reports progress via {@link onVideoSwapProgress}.
   *
   * Rejects with `E_BUSY` if a swap or another video job is already running, `E_MODELS` if
   * the required models are not on disk yet, `E_CANCELLED` if {@link cancelVideoSwap} was
   * called, `E_CONTENT` if the target was refused by the content gate, and `E_SWAP`
   * otherwise.
   */
  swapVideo(
    sourcePath: string,
    targetPath: string,
    outputPath: string,
    options?: SwapOptions
  ): Promise<SwapVideoResult>;
  /** Asks the video swap in flight to stop. Fire-and-forget — the answer arrives as the
   *  `E_CANCELLED` rejection of the {@link swapVideo} promise, not from here. */
  cancelVideoSwap(): void;
  readonly onVideoSwapProgress: CodegenTypes.EventEmitter<VideoSwapProgress>;
  /**
   * Every face detected in the photo at `sourcePath`, for a UI to let the user pick one
   * before swapping — pass the chosen face's box back as {@link SwapOptions.sourceFaceBox}.
   * Does not swap or modify anything.
   *
   * Rejects with `E_BUSY` if a swap or video job is already running, `E_MODELS` if the
   * required models are not on disk yet, and `E_DETECT` otherwise.
   */
  detectSourceFaces(sourcePath: string): Promise<DetectedFace[]>;
  /**
   * Every face detected in the target at `targetPath` — a photo, or a video (its first
   * frame, already upright) — for a UI to let the user pick one before swapping. Pass the
   * chosen face's box back as {@link SwapOptions.targetFaceBox}. Does not swap or modify
   * anything.
   *
   * Rejects with `E_BUSY` if a swap or video job is already running, `E_MODELS` if the
   * required models are not on disk yet, and `E_DETECT` otherwise.
   */
  detectTargetFaces(targetPath: string): Promise<DetectedFace[]>;
  /**
   * Copies the file at `path` — a `swapPhoto`/`swapVideo` output, typically — into the
   * system's Photos/Gallery app, under a `Facefusion` album. Returns the resulting
   * `content://` URI as a string.
   *
   * `path` and the app that owns it stay exactly as they were; this is a copy, not a move.
   * `mimeType` must be `image/*` or `video/*` — pass the real one for the file (`image/jpeg`
   * for `swapPhoto`'s default output, `video/mp4` for `swapVideo`'s), since there is no safe
   * way to guess it from an arbitrary path. `displayName` defaults to `path`'s own filename.
   *
   * No storage permission is needed for this on Android — inserting new media an app itself
   * created has never required one under scoped storage (API 29+). Rejects with `E_MIME` for
   * an unsupported `mimeType` and `E_SAVE` for anything else, naming what failed.
   */
  saveToGallery(
    path: string,
    mimeType: string,
    displayName?: string
  ): Promise<string>;
}

export default TurboModuleRegistry.getEnforcing<Spec>('Facefusion');
