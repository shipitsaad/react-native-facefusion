# react-native-facefusion

A React Native TurboModule that runs face swapping **entirely on the phone**, on
Qualcomm's Hexagon NPU. No server, no upload, no network call for inference — the
photo or video never leaves the device.

## Requirements — read this first

- **Android only.** There is no iOS implementation. This runs on Qualcomm's Hexagon
  DSP via QNN, which Apple silicon has no equivalent path for.
- **Android 12+ (`minSdk 31`), `arm64-v8a` only.**
- **A Snapdragon chip with a Hexagon NPU.** On anything else — an emulator included,
  since no emulator has a Hexagon DSP — every call still resolves, but the NPU-backed
  ones report `ok: false` rather than hanging or crashing.
- **A one-time native SDK step at install**, described below. It cannot be skipped
  and it cannot be bundled into this package — see [Install](#install).

## Install

Three steps, not one — a plain `npm install` is not enough on its own.

```sh
npm install react-native-facefusion
```

```sh
# 1. Fetch the upstream C++ engine this module wraps. Not committed to this repo or
#    to the npm package — see "Why the extra steps" below.
./node_modules/react-native-facefusion/scripts/fetch-upstream.sh
```

```sh
# 2. Get Qualcomm's QAIRT SDK (Community edition — a plain ZIP, no account needed):
#    https://www.qualcomm.com/developer/software/qualcomm-ai-runtime-sdk-qairt
# Then copy out of the ZIP into your app's android/ tree:
#   include/QNN/                                       -> android/src/main/cpp/include/QNN/
#   lib/aarch64-android/libQnnHtp.so                    -> android/src/main/jniLibs/arm64-v8a/
#   lib/aarch64-android/libQnnSystem.so                 -> android/src/main/jniLibs/arm64-v8a/
#   lib/aarch64-android/libQnnHtpV{73,79,81}Stub.so     -> android/src/main/jniLibs/arm64-v8a/
#   lib/hexagon-v{73,79,81}/unsigned/libQnnHtpV{73,79,81}Skel.so -> android/src/main/jniLibs/arm64-v8a/
```

Your app's `android/app/build.gradle` also needs:

```groovy
android {
    packagingOptions {
        jniLibs {
            useLegacyPackaging = true // required -- the QNN backend is dlopen'd by
                                       // absolute path, which needs real files on
                                       // disk, not compressed inside the APK
        }
    }
}
```

### Why the extra steps

Neither piece can legally ship inside this package:

- **The QNN runtime** is Qualcomm's, under a licence that permits redistribution
  "as incorporated in your software application" but not "on a standalone basis" —
  an app may bundle it, an npm package may not.
- **The C++ engine** this module wraps ([`AbrahamPaulJ/facefusion-mobile`](https://github.com/AbrahamPaulJ/facefusion-mobile))
  ships no LICENSE file, which defaults to all-rights-reserved. It is vendored
  unmodified and fetched at a pinned commit by `scripts/fetch-upstream.sh`, never
  committed to git history.

## Usage

```ts
import {
  probeDevice,
  getModelStatus,
  downloadModels,
  onModelDownloadProgress,
  swapPhoto,
  swapVideo,
  detectSourceFaces,
  detectTargetFaces,
  saveToGallery,
  FacefusionPreview,
} from 'react-native-facefusion';

// Check the chip and see what's already on disk.
const device = await probeDevice();       // { ok, tier, tierChain, arch, vtcmMb, ... }
const status = await getModelStatus();    // { ready, missing, tier, hasEnhancer, ... }

// Download the model set for this device's tier (~300+ MB, resumable, SHA256-verified).
if (!status.ready) {
  const sub = onModelDownloadProgress((p) => console.log(p.fileIndex, p.fileCount));
  await downloadModels();
  sub.remove();
}

// Swap a face into a photo. Paths in, path out -- no pixels cross the JS bridge.
const result = await swapPhoto(sourcePath, targetPath, outputPath, {
  faceEnhance: true,
});
// { outputPath, faceCount, tier }

// Same call shape for video -- runs behind a foreground service.
const videoResult = await swapVideo(sourcePath, targetPath, outputPath, {
  targetFps: 15, // cap the frame rate to trade quality for speed
});
// { outputPath, frameCount, faceFrameCount, tier, fps, hasAudio }

// Multiple faces in the source or target? Detect first, let the user pick, then pass
// the chosen box back into swapPhoto/swapVideo as sourceFaceBox / targetFaceBox.
const sourceFaces = await detectSourceFaces(sourcePath);
const targetFaces = await detectTargetFaces(targetPath);

// Copy an output into the Photos app -- swapPhoto/swapVideo write to your own
// app's private storage, not somewhere the user can see without this.
const uri = await saveToGallery(result.outputPath, 'image/jpeg');
```

```tsx
// Watch the swap happen live -- a native Surface the pipeline draws into directly,
// not a stream of frames sent over the bridge.
<FacefusionPreview style={{ width: '100%', aspectRatio: 16 / 9 }} />
```

Full option/result shapes (`SwapOptions`, `DeviceProbeResult`, `ModelStatus`, …) are
documented on the TypeScript types themselves — your editor will show them.

Only one swap or video job runs at a time; a second call rejects with `E_BUSY` rather
than queuing. `swapVideo` can be stopped mid-run with `cancelVideoSwap()`.

## Content gate

Every swap checks its target against upstream FaceFusion's NSFW content gate before
processing it, and refuses with `E_CONTENT` if it's flagged. This is not optional or
configurable from JS — a safeguard a caller can turn off is not a safeguard.

Known limits of this port, stated plainly rather than hidden:

- It gates on one model (`nsfw_2`) where upstream votes across three — the other two
  total 461 MB against this package's ~266 MB, and which way a single model errs
  against the full ensemble is unmeasured.
- On every chip tier except v79, the gate itself runs quantised, which measured
  ~0.087 mean closer to flagging than the full-precision model, 16 of 16 held-out
  frames in the same direction. Not compensated for — reported here instead.
- A still image is one check; a video samples one frame per second and refuses if
  more than 10% of samples are flagged.
- A failure to run the check (a native error, not a flagged result) is always treated
  as a refusal, never as "allow."

## Known issues

- **Very high-resolution target photos can crash with `OutOfMemoryError`.** Face
  detection and the swap itself convert the whole decoded image to a packed byte
  array before any cropping happens. A typical phone-camera photo is well under the
  ceiling that triggers this; a multi-thousand-pixel press photo is not. Not yet
  fixed — needs a decode-time max-dimension downscale.
- **The content gate's true-positive path is unverified.** Every test swap run
  against real hardware so far has been clean content, which only confirms clean
  content isn't wrongly flagged.
- **Not yet 16 KB page-size compatible.** Android 15+ warns on debug builds when
  native libraries aren't aligned for 16 KB memory pages. This affects the whole
  current toolchain, not just this package's own `.so` files — stock React
  Native/Hermes libraries are flagged too. Non-blocking today; worth checking again
  as 16 KB-page devices become real.

## Performance

Every number below is measured on real hardware, dated, and says exactly what was
run. None of it is upstream's own figures, and nothing here is an estimate.

| Device | Resolution | Face enhancer | fps | Date |
|---|---|---|---|---|
| Samsung SM-S931B (Snapdragon 8 Elite, tier v79) | 1280×720 | off | **9.8** | 2026-09-09 |

This is one pipeline's own decode→swap→encode loop end to end, not a swap-graph-only
figure. Expect it to vary by device tier, resolution, and whether the enhancer runs.

## Contributing

- [Development workflow](CONTRIBUTING.md#development-workflow)
- [Sending a pull request](CONTRIBUTING.md#sending-a-pull-request)
- [Code of conduct](CODE_OF_CONDUCT.md)

## License

MIT

---

Made with [create-react-native-library](https://github.com/callstack/react-native-builder-bob)
