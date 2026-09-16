import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
// React Native core's own SafeAreaView is iOS-only -- on Android it renders as a plain
// View and does nothing, which is why the title sat under the status bar. This package is
// the standard answer and reports the real insets on both edges, which matters more now
// that the screen no longer scrolls: the footer row sits right on top of the gesture-nav
// bar. Example-app only; the library itself takes no new dependency.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import {
  probeDevice,
  getModelStatus,
  downloadModels,
  cancelModelDownload,
  onModelDownloadProgress,
  swapPhoto,
  swapVideo,
  cancelVideoSwap,
  onVideoSwapProgress,
  detectSourceFaces,
  detectTargetFaces,
  saveToGallery,
  FacefusionPreview,
  type DeviceProbeResult,
  type ModelStatus,
  type ModelDownloadProgress,
  type SwapOptions,
  type SwapPhotoResult,
  type SwapVideoResult,
  type VideoSwapProgress,
  type DetectedFace,
} from 'react-native-facefusion';

// App-specific external storage (getExternalFilesDir) — avoids scoped storage restrictions.
const FILES_DIR = '/sdcard/Android/data/facefusion.example/files';

// INPUTS START EMPTY, ON PURPOSE. They used to be pre-filled with
// `${FILES_DIR}/source.jpg` etc, which does not exist on a fresh install -- so the
// fields looked ready, the obvious first action was Run Swap, and the app answered
// "Could not decode image". A first run that fails by default is worse than an empty
// field that tells you what to do, so the placeholder now points at the picker.
const DEFAULT_SOURCE = '';
const DEFAULT_TARGET = '';

// Outputs keep a real default: nobody should have to type a path for a file the app
// is about to write itself.
const DEFAULT_OUTPUT = `${FILES_DIR}/swapped.jpg`;
const DEFAULT_VIDEO_OUTPUT = `${FILES_DIR}/swapped.mp4`;

// Sample media — picked up automatically IF it is actually on the device, and ignored
// entirely if it is not.
//
// This is not a retreat from the rule above. The bug that rule exists for was pointing
// the fields at a path and *hoping*: on a fresh install the file was absent, the form
// looked ready, and the first tap answered "Could not decode image". Here nothing is
// filled in until the file has been confirmed to exist AND to decode, so a device
// without these files behaves exactly as it does today — empty fields pointing at the
// picker.
//
// Put two photos under these names to have them adopted on launch:
//   adb push a.jpg /sdcard/Android/data/facefusion.example/files/demo-source.jpg
//   adb push b.jpg /sdcard/Android/data/facefusion.example/files/demo-target.jpg
const DEMO_SOURCE = `${FILES_DIR}/demo-source.jpg`;
const DEMO_TARGET = `${FILES_DIR}/demo-target.jpg`;

// How the app tells a clip from a photo. There is one target now, not a photo target and
// a video target, so something has to decide which swap to run -- and asking the user to
// declare it first is the thing that change removed.
const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mov',
  '.m4v',
  '.3gp',
  '.mkv',
  '.webm',
  '.avi',
];

/**
 * Opens the system document picker via the example app's own `MediaPickerModule`
 * (`example/android/.../MediaPickerModule.kt` — not part of the library) and resolves with
 * a real filesystem path, or `null` if the user backed out. Requests the granular media
 * permission first; `ACTION_OPEN_DOCUMENT` does not actually need it (the Storage Access
 * Framework grants the one picked file regardless), but it's asked for anyway so a denial
 * shows up before the picker rather than as a confusing native rejection.
 */
async function pickMedia(
  kind: 'image' | 'video' | 'media'
): Promise<string | null> {
  if (Platform.OS === 'android') {
    // 'media' can return either, so ask for both rather than guessing which denial the
    // user would hit.
    const permissions =
      kind === 'media'
        ? [
            PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
            PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO,
          ]
        : [
            kind === 'video'
              ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO
              : PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES,
          ];
    await PermissionsAndroid.requestMultiple(permissions);
  }
  try {
    return await NativeModules.MediaPicker.pickMedia(kind);
  } catch {
    return null; // cancelled, or nothing selected
  }
}

export default function App() {
  // The provider has to sit above anything that reads insets, so it wraps the screen
  // rather than living inside it.
  return (
    <SafeAreaProvider>
      <AppScreen />
    </SafeAreaProvider>
  );
}

function AppScreen() {
  const [tab, setTab] = useState<'swap' | 'status'>('swap');

  // Probe & Models state
  const [probe, setProbe] = useState<DeviceProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [models, setModels] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);

  // Swap state
  const [sourcePath, setSourcePath] = useState(DEFAULT_SOURCE);
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET);
  // A custom output, only if the user actually typed one. Left null the rest of the time
  // so the output follows the target's kind automatically -- a .jpg path on a video swap
  // is a muxer failure with a confusing message, and making the user keep two output
  // fields in sync by hand is exactly the bookkeeping this redesign removes.
  const [outputOverride, setOutputOverride] = useState<string | null>(null);
  const [swapping, setSwapping] = useState(false);
  const [swapResult, setSwapResult] = useState<SwapPhotoResult | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // Bumped every time a swap finishes, and appended to the preview's file:// URI.
  //
  // Every swap writes to the SAME outputPath by default, so the URI handed to <Image>
  // was byte-identical between runs -- and React Native's image pipeline caches by URI,
  // so the second swap kept showing the FIRST swap's picture. The file on disk was
  // always correct; only the preview lied, which reads exactly like "the swap silently
  // did nothing". Reported 2026-09-14.
  //
  // A query string is the fix rather than a unique filename because the user can type
  // any path they like into the output field, including the same one twice -- the cache
  // has to be busted per RUN, not per name. Android resolves a file:// URI by its path
  // and ignores the query, so the file still opens; the cache key is the whole URI, so
  // it misses and re-reads from disk.
  const [resultStamp, setResultStamp] = useState(0);

  // "Save to Gallery" -- copies the result out of the app's own private storage into
  // MediaStore, the only door into shared storage the user's Photos app can see. One set
  // of state for both kinds of result, since only one result exists at a time. Cleared
  // whenever a new swap starts: a saved-URI line belongs to the swap that produced it.
  const [saving, setSaving] = useState(false);
  const [savedUri, setSavedUri] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Source face picker — which face in sourcePath becomes the identity, when it has more
  // than one. `null` selection means the default: the largest face, same as every swap
  // before this existed. Cleared whenever sourcePath changes, since a detected list belongs
  // to one specific photo and a stale selection would silently apply to the wrong one.
  const [sourceFaces, setSourceFaces] = useState<DetectedFace[]>([]);
  const [detectingFaces, setDetectingFaces] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(
    null
  );

  // Target face picker (photo) — which face in targetPath actually gets swapped, when it
  // has more than one. `null` selection means the default: every face found (subject to
  // `largestFaceOnly` above), same as before this existed. See ADR-0014.
  const [targetFaces, setTargetFaces] = useState<DetectedFace[]>([]);
  const [detectingTargetFaces, setDetectingTargetFaces] = useState(false);
  const [detectTargetError, setDetectTargetError] = useState<string | null>(
    null
  );
  const [selectedTargetFaceIndex, setSelectedTargetFaceIndex] = useState<
    number | null
  >(null);

  // Video-only state. There is no separate video TARGET any more -- one target holds
  // either a photo or a clip, and `targetIsVideo` below decides which swap runs. This is
  // only the things a video has and a photo does not.
  const [videoProgress, setVideoProgress] = useState<VideoSwapProgress | null>(
    null
  );
  const [videoResult, setVideoResult] = useState<SwapVideoResult | null>(null);

  // Video FPS cap — set before running the swap, per Saad's own framing. Off by default
  // (every frame, unchanged behaviour); when on, only `targetFpsValue` of the source's own
  // frames actually get swapped and encoded, the rest decoded and dropped. See ADR-0014.
  const [fpsCapEnabled, setFpsCapEnabled] = useState(false);
  const [targetFpsValue, setTargetFpsValue] = useState(15);

  // Advanced swap options — every one of these already exists on the native side
  // (SwapConfig.kt, ffpipe::Config) and was already accepted by swapPhoto()/swapVideo();
  // this is the first UI for any of them. Defaults match SwapConfig's own Kotlin defaults.
  // Shared between the photo and video cards below, since both take the same SwapOptions.
  const [optionsExpanded, setOptionsExpanded] = useState(false);

  // The raw file paths are still editable -- `adb push` + type the path is how this app
  // gets tested -- but they are collapsed by default now that the pickers show a real
  // thumbnail. A wall of /sdcard/Android/data/... strings was the first thing the screen
  // showed, and it made a working app look like a debug harness.
  const [pathsExpanded, setPathsExpanded] = useState(false);

  const [swapperWeight, setSwapperWeight] = useState(0.5);
  const [maskBlur, setMaskBlur] = useState(0.3);
  const [maskPadding, setMaskPadding] = useState(0); // one uniform value, all 4 sides
  const [detectorScore, setDetectorScore] = useState(0.5);
  const [landmarkerScore, setLandmarkerScore] = useState(0.5);
  const [pixelBoost, setPixelBoost] = useState(1);
  const [largestFaceOnly, setLargestFaceOnly] = useState(false);
  const [faceEnhance, setFaceEnhance] = useState(false);
  const [faceEnhancerBlend, setFaceEnhancerBlend] = useState(0.8);

  const selectedFace =
    selectedFaceIndex != null ? sourceFaces[selectedFaceIndex] : undefined;
  const selectedTargetFace =
    selectedTargetFaceIndex != null
      ? targetFaces[selectedTargetFaceIndex]
      : undefined;

  const faceBox = (f: DetectedFace | undefined) =>
    f ? [f.left, f.top, f.right, f.bottom] : undefined;

  // Which swap runs, decided by the target the user picked rather than by a mode they had
  // to choose first. The extension is the signal because that is what the picker copies
  // the file out as (MediaPickerModule.extensionFor) and what a typed-in path carries.
  const targetIsVideo = VIDEO_EXTENSIONS.some((ext) =>
    targetPath.toLowerCase().endsWith(ext)
  );

  const outputPath =
    outputOverride ?? (targetIsVideo ? DEFAULT_VIDEO_OUTPUT : DEFAULT_OUTPUT);

  // Shared by both photo and video — the identity (source) side is one picker either way.
  // targetFaceBox differs per target, so it's added below rather than here.
  const commonOptions = useMemo(
    () => ({
      swapperWeight,
      maskBlur,
      maskPadding: [maskPadding, maskPadding, maskPadding, maskPadding],
      detectorScore,
      landmarkerScore,
      pixelBoost,
      largestFaceOnly,
      faceEnhance,
      faceEnhancerBlend,
      sourceFaceBox: faceBox(selectedFace),
    }),
    [
      swapperWeight,
      maskBlur,
      maskPadding,
      detectorScore,
      landmarkerScore,
      pixelBoost,
      largestFaceOnly,
      faceEnhance,
      faceEnhancerBlend,
      selectedFace,
    ]
  );

  // One options object for one target. `targetFps` is harmless on the photo path (it is
  // only read by VideoSwap) but is left off unless a clip is actually selected, so what
  // gets sent matches what the screen is showing.
  const swapOptions: SwapOptions = useMemo(
    () => ({
      ...commonOptions,
      targetFaceBox: faceBox(selectedTargetFace),
      targetFps: targetIsVideo && fpsCapEnabled ? targetFpsValue : undefined,
    }),
    [
      commonOptions,
      selectedTargetFace,
      targetIsVideo,
      fpsCapEnabled,
      targetFpsValue,
    ]
  );

  // A detected-faces list belongs to one specific photo — stale results pointing at a
  // different image would silently swap the wrong face in. Bumped here and checked in
  // detectFaces()'s .then() -- a detect started against the old path can still be
  // in flight when the path changes, and its result must not land on the new one.
  const sourceFacesGeneration = useRef(0);
  useEffect(() => {
    sourceFacesGeneration.current += 1;
    setSourceFaces([]);
    setSelectedFaceIndex(null);
    setDetectError(null);
  }, [sourcePath]);

  // Zero faces is reported through the same banner as a real error, because to the person
  // holding the phone it IS the failure -- the picker just does nothing otherwise, which
  // reads as a broken build.
  //
  // The hint is not filler. Every tier ships the same yoloface graph, but compiled per
  // Hexagon architecture, so the same photo scores differently on a v68 chip than on a
  // v79 one, and `detectorScore` is a hard cutoff. A face at 0.46 on an S22 and 0.58 on an
  // S25 is found on exactly one of them, which is precisely the "works on your phone, not
  // on mine" report this text exists to answer.
  const noFacesMessage = useCallback(
    (what: string) =>
      `No ${what} found at detector confidence ${detectorScore.toFixed(2)}. ` +
      'Older chips score the same photo lower than newer ones, so try lowering ' +
      '"Detector confidence" under Advanced to about 0.30 and detecting again.',
    [detectorScore]
  );

  const detectFaces = useCallback(() => {
    // Captured now, checked when the promise settles -- see sourceFacesGeneration above.
    const generation = sourceFacesGeneration.current;
    setDetectError(null);
    setSelectedFaceIndex(null);
    setDetectingFaces(true);
    // `commonOptions`, not just the two thresholds: everything in it reaches the native
    // pipeline through `initEx`, so detecting with a different set than the swap uses
    // re-opens every model graph twice per swap.
    detectSourceFaces(sourcePath, commonOptions)
      .then((faces) => {
        if (sourceFacesGeneration.current !== generation) return; // sourcePath moved on
        setSourceFaces(faces);
        if (faces.length === 0) setDetectError(noFacesMessage('faces'));
      })
      .catch((e: Error) => {
        if (sourceFacesGeneration.current !== generation) return;
        setDetectError(e.message);
      })
      .finally(() => {
        if (sourceFacesGeneration.current === generation)
          setDetectingFaces(false);
      });
  }, [sourcePath, commonOptions, noFacesMessage]);

  // A detected-faces list belongs to one specific target -- stale results pointing at a
  // different photo would silently swap the wrong face. Same guard shape as
  // sourceFacesGeneration above.
  const targetFacesGeneration = useRef(0);
  useEffect(() => {
    targetFacesGeneration.current += 1;
    setTargetFaces([]);
    setSelectedTargetFaceIndex(null);
    setDetectTargetError(null);
  }, [targetPath]);

  const detectTargetFacesForPhoto = useCallback(() => {
    const generation = targetFacesGeneration.current;
    setDetectTargetError(null);
    setSelectedTargetFaceIndex(null);
    setDetectingTargetFaces(true);
    detectTargetFaces(targetPath, commonOptions)
      .then((faces) => {
        if (targetFacesGeneration.current !== generation) return;
        setTargetFaces(faces);
        if (faces.length === 0) {
          setDetectTargetError(
            noFacesMessage(targetIsVideo ? 'faces in the first frame' : 'faces')
          );
        }
      })
      .catch((e: Error) => {
        if (targetFacesGeneration.current !== generation) return;
        setDetectTargetError(e.message);
      })
      .finally(() => {
        if (targetFacesGeneration.current === generation)
          setDetectingTargetFaces(false);
      });
  }, [targetPath, targetIsVideo, commonOptions, noFacesMessage]);

  const runProbe = useCallback(() => {
    setProbing(true);
    probeDevice()
      .then(setProbe)
      .catch((e: Error) => setModelError(e.message))
      .finally(() => setProbing(false));
  }, []);

  const refreshModels = useCallback(() => {
    getModelStatus()
      .then(setModels)
      .catch((e: Error) => setModelError(e.message));
  }, []);

  useEffect(() => {
    runProbe();
    refreshModels();
  }, [runProbe, refreshModels]);

  // Adopt the sample media if it is there. `Image.getSize` is the existence check:
  // React Native core has no filesystem API and this app has no `react-native-fs`, and
  // getSize only succeeds on a file that both exists and actually decodes — which is a
  // stronger check than "the path is present" anyway, since an unreadable or truncated
  // file is exactly as useless to the swap as a missing one.
  //
  // The functional set guards against clobbering: the callback is async, so a fast
  // picker tap could land first, and a sample file must never overwrite a real choice.
  useEffect(() => {
    const adopt = (
      path: string,
      apply: (setter: (current: string) => string) => void
    ) => {
      Image.getSize(
        `file://${path}`,
        () => apply((current) => (current === '' ? path : current)),
        () => {} // absent or unreadable: leave the field empty, the correct default
      );
    };
    adopt(DEMO_SOURCE, setSourcePath);
    adopt(DEMO_TARGET, setTargetPath);
  }, []);

  useEffect(() => {
    const sub = onModelDownloadProgress(setProgress);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = onVideoSwapProgress(setVideoProgress);
    return () => sub.remove();
  }, []);

  const download = useCallback(() => {
    setModelError(null);
    setBusy(true);
    downloadModels()
      .then(setModels)
      .catch((e: Error) => setModelError(e.message))
      .finally(() => setBusy(false));
  }, []);

  /**
   * One button, one call. Which of the two native entry points runs is decided by the
   * target the user already picked -- there is no mode to set and no second card to
   * scroll to.
   */
  const run = useCallback(() => {
    setSwapError(null);
    setSwapResult(null);
    setVideoResult(null);
    setVideoProgress(null);
    setSavedUri(null);
    setSaveError(null);
    setSwapping(true);

    const done = () => setSwapping(false);
    if (targetIsVideo) {
      swapVideo(sourcePath, targetPath, outputPath, swapOptions)
        .then(setVideoResult)
        .catch((e: Error) => setSwapError(e.message))
        .finally(done);
    } else {
      swapPhoto(sourcePath, targetPath, outputPath, swapOptions)
        .then((r) => {
          setResultStamp(Date.now());
          setSwapResult(r);
        })
        .catch((e: Error) => setSwapError(e.message))
        .finally(done);
    }
  }, [targetIsVideo, sourcePath, targetPath, outputPath, swapOptions]);

  // The output's own extension decides the mime type, same as PhotoSwap.write()'s own
  // PNG/JPEG choice -- this is example-app glue, not the library, so it's fine to be this
  // simple rather than accept a mimeType from the UI.
  const saveResultToGallery = useCallback(() => {
    const path = videoResult?.outputPath ?? swapResult?.outputPath;
    if (path == null) return;
    setSaveError(null);
    setSaving(true);
    const lower = path.toLowerCase();
    const mimeType = videoResult
      ? 'video/mp4'
      : lower.endsWith('.png')
        ? 'image/png'
        : 'image/jpeg';
    saveToGallery(path, mimeType)
      .then(setSavedUri)
      .catch((e: Error) => setSaveError(e.message))
      .finally(() => setSaving(false));
  }, [swapResult, videoResult]);

  const pickSource = useCallback(() => {
    pickMedia('image').then((path) => path && setSourcePath(path));
  }, []);

  // "media", not "image": the target is whatever they want to swap into, and the app
  // works out which swap that means afterwards.
  const pickTarget = useCallback(() => {
    pickMedia('media').then((path) => path && setTargetPath(path));
  }, []);

  const videoPercent =
    videoProgress && videoProgress.estimatedFrameCount > 0
      ? Math.min(
          100,
          Math.floor(
            (videoProgress.frameIndex / videoProgress.estimatedFrameCount) * 100
          )
        )
      : 0;

  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(
          100,
          Math.floor((progress.doneBytes / progress.totalBytes) * 100)
        )
      : 0;

  const isReady = models?.ready === true;

  // Why "Run Swap" is unavailable, in the user's words. A dimmed button with no
  // explanation is the worst state a first-time user can land in -- they cannot tell
  // a missing 317 MB download apart from an unpicked file. `null` means good to go.
  const blocker = !isReady
    ? 'Download the models first — see Device & Models.'
    : sourcePath.trim() === ''
      ? 'Choose a source face in step 1.'
      : targetPath.trim() === ''
        ? 'Choose a photo or video in step 2.'
        : null;

  return (
    // `edges` names both ends on purpose: the top for the status bar, the bottom for the
    // gesture-nav bar the footer row would otherwise sit underneath.
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" />

      {/* Top Header Bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.appTitle}>FaceFusion</Text>
          <Text style={styles.appSub}>Qualcomm Hexagon NPU</Text>
        </View>
        <View
          style={[
            styles.statusBadge,
            isReady ? styles.badgeReady : styles.badgePending,
          ]}
        >
          <Text
            style={[
              styles.statusBadgeText,
              isReady ? styles.textReady : styles.textPending,
            ]}
          >
            {isReady ? 'Ready' : 'No Models'}
          </Text>
        </View>
      </View>

      {/* Segmented Switcher */}
      <View style={styles.segmentContainer}>
        <TouchableOpacity
          style={[styles.segment, tab === 'swap' && styles.segmentActive]}
          onPress={() => setTab('swap')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.segmentText,
              tab === 'swap' && styles.segmentTextActive,
            ]}
          >
            Swap
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.segment, tab === 'status' && styles.segmentActive]}
          onPress={() => setTab('status')}
          activeOpacity={0.7}
        >
          <Text
            style={[
              styles.segmentText,
              tab === 'status' && styles.segmentTextActive,
            ]}
          >
            Device & Models
          </Text>
        </TouchableOpacity>
      </View>

      {/* Main Content */}
      {tab === 'swap' ? (
        /* ================= SWAP VIEW =================
           One screen, deliberately not scrollable. The stage takes whatever height is
           left over and always shows the single most relevant thing, so a result never
           has to be scrolled to -- which is what a demo of this needs to be watchable,
           and what anyone holding the phone wanted anyway. The two swaps are one flow:
           the target decides whether a photo or a video swap runs, so there is no mode
           to pick and no second card. */
        <View style={styles.swapScreen}>
          {!isReady && (
            <TouchableOpacity
              style={styles.noticeBar}
              onPress={() => setTab('status')}
              activeOpacity={0.7}
            >
              <Text style={styles.noticeText}>
                Models not downloaded. Tap here to download.
              </Text>
            </TouchableOpacity>
          )}

          {/* ===== Stage ===== */}
          <View style={styles.stage}>
            {swapping ? (
              // Live, straight from the native Surface -- no pixels over the bridge.
              <FacefusionPreview style={styles.stageFill} />
            ) : swapResult != null ? (
              <Image
                style={styles.stageFill}
                source={{
                  uri: `file://${swapResult.outputPath}?v=${resultStamp}`,
                }}
                resizeMode="contain"
              />
            ) : videoResult != null ? (
              // A finished clip cannot be played here -- <Image> renders no video and
              // this app has no player -- so the stage reports instead of showing.
              <View style={styles.stageEmpty}>
                <Text style={styles.stageDoneMark}>✓</Text>
                <Text style={styles.stageDoneText}>
                  {videoResult.frameCount} frames · {videoResult.fps.toFixed(1)}{' '}
                  fps
                </Text>
                <Text style={styles.stageHint} numberOfLines={1}>
                  Saved to {videoResult.outputPath.split('/').pop()}
                </Text>
              </View>
            ) : (
              // Deliberately NOT a preview of the target. Showing the input here made it
              // look like the swap had already run and produced an unchanged picture --
              // the tiles below already show what is selected. The stage stays empty
              // until something has actually been produced.
              <View style={styles.stageEmpty}>
                <Text style={styles.stageMark}>◎</Text>
                <Text style={styles.stageHint}>
                  {blocker == null
                    ? 'Ready — tap Run Swap'
                    : 'The swapped result appears here'}
                </Text>
              </View>
            )}

            {/* Overlaid so it costs the stage no height of its own. */}
            {(swapResult != null || videoResult != null) && !swapping && (
              <View style={styles.stageBar}>
                <View style={styles.resultChips}>
                  {swapResult != null && (
                    <Text style={styles.resultChip}>
                      {swapResult.faceCount}{' '}
                      {swapResult.faceCount === 1 ? 'face' : 'faces'}
                    </Text>
                  )}
                  <Text style={styles.resultChip}>
                    {(swapResult ?? videoResult)?.tier}
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.stageSave}
                  onPress={saveResultToGallery}
                  disabled={saving}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.stageSaveText}>
                      {savedUri != null ? 'Saved ✓' : 'Save to Gallery'}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* Video progress, also overlaid. */}
            {swapping && videoProgress != null && (
              <View style={styles.stageBar}>
                <View style={styles.progressBoxOverlay}>
                  <View style={styles.progressBarTrack}>
                    <View
                      style={[
                        styles.progressBarFill,
                        { width: `${videoPercent}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.progressText}>
                    frame {videoProgress.frameIndex}
                    {videoProgress.estimatedFrameCount > 0
                      ? ` / ~${videoProgress.estimatedFrameCount}`
                      : ''}{' '}
                    · {videoProgress.fps.toFixed(1)} fps
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.stageCancel}
                  onPress={cancelVideoSwap}
                >
                  <Text style={styles.cancelButtonText}>Stop</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {(swapError != null || saveError != null) && (
            <Text style={styles.errorText} numberOfLines={2}>
              {swapError ?? saveError}
            </Text>
          )}

          {/* ===== Controls ===== */}
          <View style={styles.pairRow}>
            <MediaTile
              step="1"
              label="Source face"
              path={sourcePath}
              kind="image"
              onPress={pickSource}
            />
            <Text style={styles.pairArrow}>→</Text>
            <MediaTile
              step="2"
              label={targetIsVideo ? 'Target clip' : 'Target'}
              path={targetPath}
              kind={targetIsVideo ? 'video' : 'image'}
              onPress={pickTarget}
            />
          </View>

          {/* The face pickers, compact. Each side only takes height once it has
              something to show. */}
          {sourceFaces.length > 0 && (
            <FaceStrip
              path={sourcePath}
              faces={sourceFaces}
              selected={selectedFaceIndex}
              onSelect={setSelectedFaceIndex}
              defaultLabel="Largest"
            />
          )}
          {targetFaces.length > 0 && (
            <FaceStrip
              // A clip's faces come from its first frame, which cannot be rendered here.
              path={targetIsVideo ? null : targetPath}
              faces={targetFaces}
              selected={selectedTargetFaceIndex}
              onSelect={setSelectedTargetFaceIndex}
              defaultLabel="All faces"
            />
          )}

          <TouchableOpacity
            style={[
              styles.primaryButton,
              blocker != null && styles.buttonDisabled,
            ]}
            onPress={run}
            disabled={swapping || blocker != null}
            activeOpacity={0.8}
          >
            {swapping ? (
              <ActivityIndicator size="small" color="#000000" />
            ) : (
              <Text
                style={[
                  styles.primaryButtonText,
                  blocker != null && styles.buttonDisabledText,
                ]}
              >
                <Text style={styles.stepNumber}>3</Text>{' '}
                {targetIsVideo ? 'Run Video Swap' : 'Run Swap'}
              </Text>
            )}
          </TouchableOpacity>

          {blocker != null && !swapping && (
            <Text style={styles.blockerText}>{blocker}</Text>
          )}

          {/* Everything that is not the main flow, on one line. */}
          <View style={styles.footerRow}>
            <TouchableOpacity
              onPress={detectFaces}
              disabled={detectingFaces || !isReady || sourcePath.trim() === ''}
            >
              <Text
                style={[
                  styles.footerLink,
                  (!isReady || sourcePath.trim() === '') &&
                    styles.footerLinkDisabled,
                ]}
              >
                {detectingFaces ? 'Detecting…' : 'Source faces'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={detectTargetFacesForPhoto}
              disabled={
                detectingTargetFaces || !isReady || targetPath.trim() === ''
              }
            >
              <Text
                style={[
                  styles.footerLink,
                  (!isReady || targetPath.trim() === '') &&
                    styles.footerLinkDisabled,
                ]}
              >
                {detectingTargetFaces ? 'Detecting…' : 'Target faces'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setOptionsExpanded(true)}>
              <Text style={styles.footerLink}>Options</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setPathsExpanded(true)}>
              <Text style={styles.footerLink}>Paths</Text>
            </TouchableOpacity>
          </View>

          {(detectError != null || detectTargetError != null) && (
            <Text style={styles.errorText} numberOfLines={3}>
              {detectError ?? detectTargetError}
            </Text>
          )}

          {/* ===== Advanced options, in a sheet rather than on the screen =====
              These are expert controls and there are eleven of them; inline they were
              most of the screen's height for something a first run never touches. */}
          <Sheet
            visible={optionsExpanded}
            title="Options"
            onClose={() => setOptionsExpanded(false)}
          >
            {targetIsVideo && (
              <>
                <ToggleRow
                  label="Limit video FPS (faster swap, choppier output)"
                  value={fpsCapEnabled}
                  onChange={setFpsCapEnabled}
                />
                {fpsCapEnabled && (
                  <NumberStepper
                    label="Target FPS"
                    value={targetFpsValue}
                    onChange={(v) => setTargetFpsValue(Math.round(v))}
                    min={1}
                    max={30}
                    step={1}
                  />
                )}
                <Separator />
              </>
            )}
            <NumberStepper
              label="Blend (source ↔ target identity)"
              value={swapperWeight}
              onChange={setSwapperWeight}
              min={0}
              max={1}
              step={0.05}
            />
            <NumberStepper
              label="Mask blur"
              value={maskBlur}
              onChange={setMaskBlur}
              min={0}
              max={1}
              step={0.05}
            />
            <NumberStepper
              label="Mask padding"
              value={maskPadding}
              onChange={setMaskPadding}
              min={0}
              max={100}
              step={5}
              format={(v) => `${v}%`}
            />
            <NumberStepper
              label="Detector confidence"
              value={detectorScore}
              onChange={setDetectorScore}
              min={0}
              max={1}
              step={0.05}
            />
            <NumberStepper
              label="Landmarker confidence"
              value={landmarkerScore}
              onChange={setLandmarkerScore}
              min={0}
              max={1}
              step={0.05}
            />
            <NumberStepper
              label="Pixel boost"
              value={pixelBoost}
              onChange={(v) => setPixelBoost(Math.round(v))}
              min={1}
              max={4}
              step={1}
              format={(v) => `${v}× (${256 * v}px)`}
            />
            <ToggleRow
              label="Swap largest face only (target)"
              value={largestFaceOnly}
              onChange={setLargestFaceOnly}
            />
            <ToggleRow
              label={
                models?.hasEnhancer
                  ? 'Face enhancer'
                  : 'Face enhancer (not downloaded)'
              }
              value={faceEnhance}
              onChange={setFaceEnhance}
              disabled={!models?.hasEnhancer}
            />
            {faceEnhance && (
              <NumberStepper
                label="Enhancer blend"
                value={faceEnhancerBlend}
                onChange={setFaceEnhancerBlend}
                min={0}
                max={1}
                step={0.1}
              />
            )}
          </Sheet>

          {/* ===== Raw paths, same sheet treatment. `adb push` + type a path is still
              how this gets tested; it just is not the screen any more. ===== */}
          <Sheet
            visible={pathsExpanded}
            title="File paths"
            onClose={() => setPathsExpanded(false)}
          >
            <Text style={styles.inputLabel}>Source</Text>
            <TextInput
              style={styles.input}
              value={sourcePath}
              onChangeText={setSourcePath}
              placeholder="the face to copy from"
              placeholderTextColor="#636366"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.inputLabel}>Target (photo or video)</Text>
            <TextInput
              style={styles.input}
              value={targetPath}
              onChangeText={setTargetPath}
              placeholder="the photo or clip to change"
              placeholderTextColor="#636366"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.inputLabel}>
              Output {outputOverride == null ? '(following the target)' : ''}
            </Text>
            <TextInput
              style={styles.input}
              value={outputPath}
              onChangeText={setOutputOverride}
              placeholder="where to write the result"
              placeholderTextColor="#636366"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </Sheet>
        </View>
      ) : (
        <ScrollView
          style={styles.content}
          contentContainerStyle={styles.contentInner}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* ================= DEVICE & MODELS VIEW ================= */}
          <View style={styles.tabPane}>
            {/* Device Section */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>Device</Text>
                {probing && <ActivityIndicator size="small" color="#8e8e93" />}
              </View>

              {probe == null ? (
                <Text style={styles.mutedText}>Probing device…</Text>
              ) : (
                <>
                  <Row label="Tier" value={probe.tier} />
                  <Separator />
                  <Row label="Chain" value={probe.tierChain.join(' → ')} />
                  <Separator />
                  <Row label="Verified NPU" value={probe.ok ? 'Yes' : 'No'} />
                  <Separator />
                  <Row
                    label="Architecture"
                    value={probe.ok ? `v${probe.arch}` : '—'}
                  />
                  <Separator />
                  <Row
                    label="VTCM Memory"
                    value={probe.ok ? `${probe.vtcmMb} MB` : '—'}
                  />
                  <Separator />
                  <Row
                    label="SoC ID"
                    value={probe.ok ? String(probe.socModel) : '—'}
                  />
                  {probe.error ? (
                    <>
                      <Separator />
                      <Text style={styles.errorText}>{probe.error}</Text>
                    </>
                  ) : null}
                </>
              )}
            </View>

            {/* Models Section */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>Models</Text>
              </View>

              {models == null ? (
                <Text style={styles.mutedText}>Checking models…</Text>
              ) : (
                <>
                  <Row
                    label="Status"
                    value={models.ready ? 'Ready' : 'Incomplete'}
                    highlight={models.ready}
                  />
                  <Separator />
                  <Row label="Active Tier" value={models.tier} />
                  <Separator />
                  <Row
                    label="Missing"
                    value={models.ready ? 'None' : models.missing.join(', ')}
                  />
                  <Separator />
                  <Row
                    label="Enhancer"
                    value={models.hasEnhancer ? 'Installed' : 'None'}
                  />
                  <Separator />
                  <Row
                    label="Network"
                    value={models.metered ? 'Metered' : 'Unmetered'}
                  />
                </>
              )}

              {/* Progress UI */}
              {progress != null && busy && (
                <View style={styles.progressBox}>
                  <View style={styles.progressBarTrack}>
                    <View
                      style={[styles.progressBarFill, { width: `${percent}%` }]}
                    />
                  </View>
                  <Text style={styles.progressText}>
                    {progress.name ? `${progress.name} · ` : ''}
                    {(progress.doneBytes / 1e6).toFixed(1)} /{' '}
                    {(progress.totalBytes / 1e6).toFixed(1)} MB ({percent}%)
                  </Text>
                </View>
              )}

              {modelError != null && (
                <Text style={styles.errorText}>{modelError}</Text>
              )}

              {/* Download Buttons */}
              {models != null && !models.ready && !busy && (
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={download}
                >
                  <Text style={styles.secondaryButtonText}>
                    {models.metered
                      ? 'Download Models (~317 MB, Metered)'
                      : 'Download Models (~317 MB)'}
                  </Text>
                </TouchableOpacity>
              )}

              {busy && (
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.cancelButton]}
                  onPress={cancelModelDownload}
                >
                  <Text style={styles.cancelButtonText}>Cancel Download</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

/**
 * One detected face, cropped out of the photo it was found in.
 *
 * There is no crop API in React Native core and this app has no image library, so the
 * crop is done with layout instead: a fixed-size window with `overflow: 'hidden'`
 * holding the whole photo, scaled up and shifted so the detector's box lands inside the
 * window.
 *
 * This is the reason `DetectedFace` carries `imageWidth`/`imageHeight` at all. The box
 * is in the *analysed bitmap's* coordinate space, which is not the file's pixel size --
 * a photo is capped and subsampled before detection -- so the numbers are only
 * meaningful as a ratio against those two. Scaling by that ratio means the same maths
 * works whatever the file's real resolution is.
 */
function FaceThumb({
  path,
  face,
  size,
}: {
  path: string;
  face: DetectedFace;
  size: number;
}) {
  // A window wider than the box itself. A tight crop on the detector's own box cuts the
  // hairline and chin, and two faces cropped that tightly look far more alike than they
  // are -- which defeats the point of showing them at all.
  const window = Math.max(face.right - face.left, face.bottom - face.top) * 1.6;
  const centerX = (face.left + face.right) / 2;
  const centerY = (face.top + face.bottom) / 2;
  const scale = size / window;

  return (
    <View style={[styles.faceThumb, { width: size, height: size }]}>
      <Image
        source={{ uri: `file://${path}` }}
        // Geometry only -- it is computed per face and cannot live in a stylesheet.
        style={[
          styles.faceThumbImage,
          {
            width: face.imageWidth * scale,
            height: face.imageHeight * scale,
            left: (window / 2 - centerX) * scale,
            top: (window / 2 - centerY) * scale,
          },
        ]}
      />
    </View>
  );
}

/**
 * The face picker: the default option plus one tile per detected face.
 *
 * `path` is the photo the faces were found in — when it is null (a video, whose first
 * frame this app has no way to render) the tiles fall back to numbered placeholders,
 * which is what every picker in this app used to be.
 */
function FaceStrip({
  path,
  faces,
  selected,
  onSelect,
  defaultLabel,
}: {
  path: string | null;
  faces: DetectedFace[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  defaultLabel: string;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.faceStrip}
    >
      <TouchableOpacity
        style={[
          styles.faceOption,
          selected === null && styles.faceOptionSelected,
        ]}
        onPress={() => onSelect(null)}
        activeOpacity={0.8}
      >
        <View style={[styles.faceThumb, styles.faceThumbAuto]}>
          <Text style={styles.faceThumbAutoMark}>A</Text>
        </View>
        <Text style={styles.faceOptionLabel} numberOfLines={1}>
          {defaultLabel}
        </Text>
      </TouchableOpacity>

      {faces.map((face, i) => (
        <TouchableOpacity
          key={i}
          style={[
            styles.faceOption,
            selected === i && styles.faceOptionSelected,
          ]}
          onPress={() => onSelect(i)}
          activeOpacity={0.8}
        >
          {path != null ? (
            <FaceThumb path={path} face={face} size={62} />
          ) : (
            <View style={[styles.faceThumb, styles.faceThumbAuto]}>
              <Text style={styles.faceThumbAutoMark}>{i + 1}</Text>
            </View>
          )}
          <Text style={styles.faceOptionLabel} numberOfLines={1}>
            {(face.score * 100).toFixed(0)}%
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

/**
 * The source/target picker tile: the picked image itself, or an empty state that says
 * what to do. Replaces a label + "Choose photo…" link + a raw path in a TextInput, which
 * gave no confirmation of *what* had been picked -- the single most confusing thing about
 * the old screen, since a wrong pick looked identical to a right one.
 */
function MediaTile({
  step,
  label,
  path,
  kind,
  onPress,
}: {
  step: string;
  label: string;
  path: string;
  kind: 'image' | 'video';
  onPress: () => void;
}) {
  const filled = path.trim() !== '';
  return (
    <TouchableOpacity style={styles.tile} onPress={onPress} activeOpacity={0.8}>
      <View style={styles.tileFrame}>
        {filled && kind === 'image' ? (
          <Image
            source={{ uri: `file://${path}` }}
            style={styles.tileImage}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.tileEmpty}>
            <Text style={styles.tileEmptyMark}>{filled ? '▶' : '+'}</Text>
            {filled && (
              <Text style={styles.tileEmptyText} numberOfLines={1}>
                {path.split('/').pop()}
              </Text>
            )}
          </View>
        )}
      </View>
      <View style={styles.tileCaption}>
        <Text style={styles.tileStep}>{step}</Text>
        <Text style={styles.tileLabel} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Text style={styles.tileAction}>
        {filled ? 'Change' : kind === 'video' ? 'Choose video' : 'Choose photo'}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * A bottom sheet for the things that are not the main flow — advanced options, raw
 * paths. They used to be collapsible cards in the page, which is why the page had to
 * scroll at all: eleven steppers and three text fields were taller than the actual job.
 *
 * `Modal` is React Native core, so this costs no dependency. `presentationStyle` is left
 * alone and the backdrop is drawn here instead, because the stock Android modal is opaque
 * full-screen and loses the sense that the swap screen is still underneath.
 */
function Sheet({
  visible,
  title,
  onClose,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose} // the Android back button, which must close a sheet
    >
      <View style={styles.sheetBackdrop}>
        <TouchableOpacity
          style={styles.sheetDismissArea}
          onPress={onClose}
          activeOpacity={1}
        />
        <View style={styles.sheet}>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={12}>
              <Text style={styles.sheetDone}>Done</Text>
            </TouchableOpacity>
          </View>
          <ScrollView
            style={styles.sheetBody}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Row({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, highlight && styles.valueHighlight]}>
        {value}
      </Text>
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

/** No slider in bare RN core (`@react-native-community/slider` is a separate install this
 *  project doesn't otherwise need) — a stepper is one fewer dependency for the same knob. */
function NumberStepper({
  label,
  value,
  onChange,
  min,
  max,
  step,
  format,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, +v.toFixed(2)));
  return (
    <View style={styles.stepperRow}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.stepperControls}>
        <TouchableOpacity
          style={styles.stepperButton}
          onPress={() => onChange(clamp(value - step))}
        >
          <Text style={styles.stepperButtonText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>
          {format ? format(value) : value.toFixed(2)}
        </Text>
        <TouchableOpacity
          style={styles.stepperButton}
          onPress={() => onChange(clamp(value + step))}
        >
          <Text style={styles.stepperButtonText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.label, disabled && styles.mutedText]}>{label}</Text>
      <Switch value={value} onValueChange={onChange} disabled={disabled} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#000000',
    // No manual StatusBar.currentHeight padding any more -- SafeAreaView supplies the
    // real inset on both edges, and doing both double-padded the top.
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  appTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.4,
  },
  appSub: {
    fontSize: 12,
    color: '#8e8e93',
  },
  statusBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  badgeReady: {
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
  },
  badgePending: {
    backgroundColor: 'rgba(255, 159, 10, 0.15)',
  },
  statusBadgeText: {
    fontSize: 11,
    fontWeight: '600',
  },
  textReady: {
    color: '#34c759',
  },
  textPending: {
    color: '#ff9f0a',
  },
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 2,
  },
  segment: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 6,
  },
  segmentActive: {
    backgroundColor: '#2c2c2e',
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8e8e93',
  },
  segmentTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  contentInner: {
    paddingHorizontal: 16,
    paddingBottom: 24,
  },
  tabPane: {
    gap: 12,
  },
  noticeBar: {
    backgroundColor: '#2c2c2e',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  noticeText: {
    fontSize: 12,
    color: '#ff9f0a',
    textAlign: 'center',
    fontWeight: '500',
  },
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 14,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8e8e93',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // The step number badge in "1 Source face" / "2 Target photo" / "3 Run Swap" --
  // the flow used to be implicit and a first-time user had to infer the order.
  stepNumber: {
    color: '#0a84ff',
    fontWeight: '700',
  },
  // Why the primary button is disabled, said out loud. Amber, not red: nothing has
  // gone wrong yet, the user just has a step left.
  blockerText: {
    marginTop: 8,
    fontSize: 12,
    color: '#ff9f0a',
    textAlign: 'center',
  },
  hint: {
    fontSize: 11,
    color: '#8e8e93',
    marginBottom: 10,
    lineHeight: 15,
  },
  inputLabel: {
    fontSize: 12,
    color: '#8e8e93',
    marginBottom: 4,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pickLink: {
    fontSize: 12,
    color: '#0a84ff',
    fontWeight: '600',
    marginBottom: 4,
  },
  pickLinkDisabled: {
    color: '#48484a',
  },
  input: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: '#ffffff',
    marginBottom: 8,
    fontVariant: ['tabular-nums'],
  },
  primaryButton: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 14,
  },
  secondaryButton: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  // A dimmed WHITE button is a big pale slab that reads as broken rather than as
  // not-yet-available. Disabled is its own colour instead: clearly inert, clearly not an
  // error, and the blocker line underneath says what is missing.
  buttonDisabled: {
    backgroundColor: '#2c2c2e',
    opacity: 1,
  },
  buttonDisabledText: {
    color: '#636366',
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  },
  cancelButton: {
    backgroundColor: '#3a1c1c',
  },
  cancelButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ff453a',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 5,
  },
  label: {
    fontSize: 13,
    color: '#8e8e93',
  },
  value: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 12,
  },
  valueHighlight: {
    color: '#34c759',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#2c2c2e',
    marginVertical: 3,
  },
  mutedText: {
    fontSize: 13,
    color: '#636366',
    paddingVertical: 4,
  },
  errorBox: {
    backgroundColor: 'rgba(255, 69, 58, 0.12)',
    padding: 10,
    borderRadius: 8,
  },
  errorText: {
    fontSize: 12,
    color: '#ff453a',
  },
  resultMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  resultMetaText: {
    fontSize: 13,
    color: '#8e8e93',
  },
  resultBold: {
    color: '#ffffff',
    fontWeight: '600',
  },
  resultPathText: {
    fontSize: 11,
    color: '#636366',
    marginBottom: 8,
    fontVariant: ['tabular-nums'],
  },
  previewContainer: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: 200,
  },
  // The result deserves more room than a 200px strip -- it is the thing the whole
  // screen exists to produce, and it was previously the same size as a progress preview.
  resultFrame: {
    borderRadius: 10,
    marginBottom: 8,
  },
  resultImage: {
    width: '100%',
    height: 300,
  },
  resultChips: {
    flexDirection: 'row',
    gap: 6,
  },
  resultChip: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8e8e93',
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },
  progressBox: {
    marginTop: 10,
  },
  progressBarTrack: {
    height: 4,
    backgroundColor: '#2c2c2e',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#ffffff',
  },
  progressText: {
    fontSize: 11,
    color: '#8e8e93',
    marginTop: 5,
    fontVariant: ['tabular-nums'],
  },
  optionsBody: {
    marginTop: 10,
    gap: 4,
  },
  stepperRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  stepperButton: {
    width: 26,
    height: 26,
    borderRadius: 6,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#ffffff',
  },
  stepperValue: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    minWidth: 56,
    textAlign: 'center',
  },
  // ===== Source → target pair =====
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  pairArrow: {
    fontSize: 17,
    color: '#636366',
    fontWeight: '600',
  },
  tile: {
    flex: 1,
  },
  tileFrame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#2c2c2e',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3a3a3c',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 8,
  },
  tileEmptyMark: {
    fontSize: 22,
    color: '#636366',
    fontWeight: '300',
  },
  tileEmptyText: {
    fontSize: 10,
    color: '#8e8e93',
    textAlign: 'center',
  },
  tileCaption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 7,
  },
  tileStep: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0a84ff',
    backgroundColor: 'rgba(10, 132, 255, 0.15)',
    width: 15,
    height: 15,
    borderRadius: 8,
    textAlign: 'center',
    lineHeight: 15,
    overflow: 'hidden',
  },
  tileLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
    flexShrink: 1,
  },
  tileAction: {
    fontSize: 11,
    color: '#0a84ff',
    fontWeight: '500',
    marginTop: 1,
  },

  // ===== Face picker =====
  pickerBlock: {
    marginTop: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#2c2c2e',
  },
  pickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    minHeight: 20,
  },
  pickerTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  pickerEmpty: {
    fontSize: 11,
    color: '#636366',
    marginTop: 4,
    lineHeight: 15,
  },
  faceStrip: {
    flexDirection: 'row',
    gap: 8,
    paddingTop: 10,
    paddingBottom: 2,
    paddingRight: 4,
  },
  faceOption: {
    alignItems: 'center',
    padding: 3,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    width: 72,
  },
  faceOptionSelected: {
    borderColor: '#0a84ff',
    backgroundColor: 'rgba(10, 132, 255, 0.12)',
  },
  faceOptionLabel: {
    fontSize: 10,
    color: '#8e8e93',
    marginTop: 3,
    fontVariant: ['tabular-nums'],
  },
  faceThumb: {
    width: 62,
    height: 62,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#2c2c2e',
  },
  faceThumbImage: {
    position: 'absolute',
  },
  faceThumbAuto: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceThumbAutoMark: {
    fontSize: 18,
    fontWeight: '600',
    color: '#8e8e93',
  },

  // ===== Collapsed raw paths =====
  pathsToggle: {
    marginTop: 12,
    alignItems: 'center',
  },
  pathsToggleText: {
    fontSize: 11,
    color: '#636366',
    fontWeight: '500',
  },

  // ===== Single-screen swap layout =====
  // No ScrollView: the stage takes the slack (`flex: 1`) and the controls under it are
  // their own natural height, so the whole job fits one screen at any device height.
  swapScreen: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 8,
  },
  stage: {
    flex: 1,
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#0e0e10',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#2c2c2e',
    justifyContent: 'center',
  },
  stageFill: {
    width: '100%',
    height: '100%',
  },
  stageEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  stageMark: {
    fontSize: 34,
    color: '#48484a',
    fontWeight: '200',
  },
  stageDoneMark: {
    fontSize: 34,
    color: '#34c759',
  },
  stageDoneText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
    fontVariant: ['tabular-nums'],
  },
  stageHint: {
    fontSize: 12,
    color: '#8e8e93',
    textAlign: 'center',
  },
  // Overlaid rather than stacked, so showing a result costs the stage no height.
  stageBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
  },
  stageSave: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
  },
  stageSaveText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  stageCancel: {
    backgroundColor: '#3a1c1c',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  progressBoxOverlay: {
    flex: 1,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 2,
  },
  footerLink: {
    fontSize: 12,
    color: '#0a84ff',
    fontWeight: '500',
  },
  footerLinkDisabled: {
    color: '#48484a',
  },

  // ===== Sheet =====
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
  },
  sheetDismissArea: {
    flex: 1,
  },
  sheet: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 16,
    paddingBottom: 24,
    maxHeight: '75%',
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
  },
  sheetDone: {
    fontSize: 14,
    fontWeight: '600',
    color: '#0a84ff',
  },
  sheetBody: {
    marginBottom: 4,
  },
});
