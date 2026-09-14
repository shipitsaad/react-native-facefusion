# react-native-facefusion

A React Native TurboModule that runs face swapping **entirely on the phone**, on
Qualcomm's Hexagon NPU. No server, no upload, no network call for inference — the
photo or video never leaves the device.

## Requirements — read this first

- **Android only.** There is no iOS implementation. This runs on Qualcomm's Hexagon
  DSP via QNN, which Apple silicon has no equivalent path for.
- **Android 12+ (`minSdk 31`), `arm64-v8a` only.**
- **A Snapdragon chip with a Hexagon NPU**, and one whose Hexagon architecture your
  build actually bundles a runtime for. The example app ships **v68, v69, v73, v75, v79
  and v81** — roughly Snapdragon 888 through 8 Elite Gen 5. The architecture is a
  property of the silicon and is chosen independently of the model tier, so a build
  missing that pair cannot reach the DSP on that phone at all; `probeDevice()` reports
  which ones the build contains. v66 and older cannot be supported: that generation
  predates the HTP backend entirely and QAIRT ships it only as a `QnnDsp` build.
- On anything else — an emulator included, since no emulator has a Hexagon DSP — every
  call still resolves, but the NPU-backed ones report `ok: false` rather than hanging or
  crashing.
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
#
# Copy out of the ZIP into THIS PACKAGE's directory (not your app's) -- CMake resolves
# the headers relative to its own source dir, so they have to live here:
#
#   PKG=node_modules/react-native-facefusion/android/src/main
#
#   include/QNN/                                -> $PKG/cpp/include/QNN/
#   lib/aarch64-android/libQnnHtp.so            -> $PKG/jniLibs/arm64-v8a/
#   lib/aarch64-android/libQnnSystem.so         -> $PKG/jniLibs/arm64-v8a/
#   lib/aarch64-android/libQnnHtpV*Stub.so      -> $PKG/jniLibs/arm64-v8a/   (ALL of them)
#   lib/hexagon-v*/unsigned/libQnnHtpV*Skel.so  -> $PKG/jniLibs/arm64-v8a/   (ALL of them)
#
# Copy EVERY architecture, not a chosen few. libQnnHtp.so picks the Stub/Skel pair from
# the chip's own Hexagon architecture, not from the model tier -- so a missing pair means
# "deviceCreate failed -- the DSP is not reachable from this process" on every phone of
# that generation, however many models are downloaded. ~12 MB per architecture.
#
# Leave out libQnnHtpPrepare.so -- it's the on-device graph compiler (82 MB) and the
# models arrive pre-compiled, so it is exactly the step this never performs.
```

**Script steps 1 and 2.** Both write into `node_modules/`, so a fresh `npm install`
or `npm ci` wipes them. Put them in a checked-in setup script (or a `postinstall`)
rather than running them by hand once and forgetting — a CI machine or a new
teammate's clone will otherwise fail at CMake configure with a message naming the
missing piece.

**Your app's `android/build.gradle` needs `minSdkVersion = 31`.** A fresh React Native
app is `24`, and this package builds against your value, not its own — so leaving it at
24 produces an APK that installs on Android 7 and crashes there instead of reporting an
unsupported device. The library refuses to build below 31, so the manifest merge fails
with a message naming it rather than building something that cannot work:

```groovy
// android/build.gradle
buildscript {
    ext {
        minSdkVersion = 31 // required -- the default 24 is below what this package supports
    }
}
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
// Pass the SAME options you pass to the swap. A picker that finds a face the swap then
// rejects is a picker that lies -- and these thresholds reach the pipeline through its
// init, so detecting at different values re-opens every model graph twice per swap.
const sourceFaces = await detectSourceFaces(sourcePath, { detectorScore: 0.5 });
const targetFaces = await detectTargetFaces(targetPath, { detectorScore: 0.5 });

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

Both branches are verified on real hardware (Snapdragon 8 Elite, tier v79): every
clean test swap passes the same check, and an NSFW test image scored ~0.8 against the
0.25 threshold and was refused with `E_CONTENT` before the swap ran or any output file
was written (2026-09-11). Not yet exercised on hardware: a video refused on the
aggregate 10% rate, and the native-error-means-refusal path.

## Known issues

- **A photo swap's output is capped at 2560 px on the long edge** (and a source photo
  is subsampled to 1920, which costs nothing — it only contributes an identity, never
  output pixels). This is deliberate: the pipeline holds roughly 19 bytes per pixel at
  once, so an uncapped 50 MP photo — the main camera on the phones this library
  requires — needs ~950 MB and cannot run at all. Videos are unaffected; they process
  at the clip's own resolution.
- **The same photo can be detected on one chip and not on another.** Every tier ships the
  same 4.0 MB `yoloface` detector, but as a *separately compiled QNN context binary per
  Hexagon architecture* — the weights are identical, the compiled graph is not. The same
  face therefore scores differently on a v68 chip than on a v79 one, and `detectorScore`
  is a hard cutoff (`score <= detectorScore` is dropped outright), so a face scoring 0.46
  on a Snapdragon 8 Gen 1 and 0.58 on an 8 Elite is found on exactly one of the two.
  Observed 2026-09-14: the same photo detected and swapped on an S25 (tier v79) and was
  not detected on an S22 (tier v68); other photos worked on both.

  This is not something the library can normalise away — there is no per-tier calibration
  to apply and no ground truth on the device to calibrate against. What it does instead is
  make the threshold reachable: `detectorScore` is an option on `swapPhoto`, `swapVideo`,
  `detectSourceFaces` and `detectTargetFaces` alike. **Expose it in your UI rather than
  treating an empty detection result as final** — around `0.3` recovers most of the gap,
  at the cost of more false positives on busy backgrounds. The example app shows the
  pattern: zero faces is reported with the current threshold named, not as silence.

- **Qualcomm's Hexagon skel libraries are not 16 KB page-size aligned.** Android 15+ warns when
  an APK contains a native library aligned to the old 4 KB page assumption. Measured
  across all 25 libraries in a release build: 19 are aligned correctly, including this
  package's own `libffnative.so` and every React Native and Hermes library. The six
  that are not are `libQnnHtpV*Skel.so` — one per Hexagon architecture — which ship
  prebuilt in Qualcomm's
  QAIRT SDK and can only be fixed upstream. They are Hexagon DSP images loaded over
  fastrpc rather than mapped into the app's address space, so this is a packaging-check
  warning rather than a loading failure — but the warning is shown to users on Android
  15+, and it will not go away until Qualcomm ships aligned builds.

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
