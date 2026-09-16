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
  acknowledgeUsagePolicy,
  isUsagePolicyAcknowledged,
  USAGE_POLICY_TEXT,
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

// App-specific external storage (getExternalFilesDir) - avoids scoped storage restrictions.
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

// Sample media - picked up automatically IF it is actually on the device, and ignored
// entirely if it is not.
//
// This is not a retreat from the rule above. The bug that rule exists for was pointing
// the fields at a path and *hoping*: on a fresh install the file was absent, the form
// looked ready, and the first tap answered "Could not decode image". Here nothing is
// filled in until the file has been confirmed to exist AND to decode, so a device
// without these files behaves exactly as it does today - empty fields pointing at the
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
 * (`example/android/.../MediaPickerModule.kt` - not part of the library) and resolves with
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

  // Usage-policy acknowledgement -- swapPhoto()/swapVideo() both reject `E_POLICY` until
  // acknowledgeUsagePolicy() has been called once on this device (UsagePolicyGate.kt).
  // This screen's version of that call is the modal below; a real app can put its own
  // words in front of USAGE_POLICY_TEXT's meaning as long as it calls the same function.
  // `null` means "still asking the native side", not "not agreed" -- flashing the gate for
  // one frame on every launch before that answer arrives would be its own small lie.
  const [policyAcknowledged, setPolicyAcknowledged] = useState<boolean | null>(
    null
  );
  const [acknowledging, setAcknowledging] = useState(false);

  useEffect(() => {
    isUsagePolicyAcknowledged()
      .then(setPolicyAcknowledged)
      .catch(() => setPolicyAcknowledged(false));
  }, []);

  const acceptPolicy = useCallback(() => {
    setAcknowledging(true);
    acknowledgeUsagePolicy()
      .then(() => setPolicyAcknowledged(true))
      .catch(() => setPolicyAcknowledged(false))
      .finally(() => setAcknowledging(false));
  }, []);

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

  // Source face picker - which face in sourcePath becomes the identity, when it has more
  // than one. `null` selection means the default: the largest face, same as every swap
  // before this existed. Cleared whenever sourcePath changes, since a detected list belongs
  // to one specific photo and a stale selection would silently apply to the wrong one.
  const [sourceFaces, setSourceFaces] = useState<DetectedFace[]>([]);
  const [detectingFaces, setDetectingFaces] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [selectedFaceIndex, setSelectedFaceIndex] = useState<number | null>(
    null
  );

  // Target face picker (photo) - which face in targetPath actually gets swapped, when it
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

  // Video FPS cap -- set before running the swap, per Saad's own framing. Off by default
  // (every frame, unchanged behaviour); when on, only `targetFpsValue` of the source's own
  // frames actually get swapped and encoded, the rest decoded and dropped. See ADR-0014.
  const [fpsCapEnabled, setFpsCapEnabled] = useState(false);
  const [targetFpsValue, setTargetFpsValue] = useState(15);

  // Advanced swap options -- every one of these already exists on the native side
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

  const isOptionsModified =
    swapperWeight !== 0.5 ||
    maskBlur !== 0.3 ||
    maskPadding !== 0 ||
    detectorScore !== 0.5 ||
    landmarkerScore !== 0.5 ||
    pixelBoost !== 1 ||
    largestFaceOnly !== false ||
    faceEnhance !== false ||
    faceEnhancerBlend !== 0.8 ||
    fpsCapEnabled !== false ||
    targetFpsValue !== 15;

  const resetOptions = useCallback(() => {
    setSwapperWeight(0.5);
    setMaskBlur(0.3);
    setMaskPadding(0);
    setDetectorScore(0.5);
    setLandmarkerScore(0.5);
    setPixelBoost(1);
    setLargestFaceOnly(false);
    setFaceEnhance(false);
    setFaceEnhancerBlend(0.8);
    setFpsCapEnabled(false);
    setTargetFpsValue(15);
  }, []);

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

  // Shared by both photo and video -- the identity (source) side is one picker either way.
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

  // A detected-faces list belongs to one specific photo -- stale results pointing at a
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
      '"Detector confidence" under Options to about 0.30 and detecting again.',
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
  // getSize only succeeds on a file that both exists and actually decodes - which is a
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
  const blocker = policyAcknowledged !== true
    ? 'Agree to the usage policy first.'
    : !isReady
    ? 'Download the models first. See Device & Models tab.'
    : sourcePath.trim() === ''
      ? 'Select a source face in step 1.'
      : targetPath.trim() === ''
        ? 'Select a photo or video target in step 2.'
        : null;

  return (
    // `edges` names both ends on purpose: the top for the status bar, the bottom for the
    // gesture-nav bar the footer row would otherwise sit underneath.
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <StatusBar barStyle="light-content" backgroundColor="#09090b" />

      {/* Usage-policy gate. No backdrop dismiss, no back-button dismiss (onRequestClose
          is a no-op) -- unlike Sheet, agreeing is not optional, it is what unblocks
          Run Swap in the first place. See the state above for why this is `=== false`
          and not `!policyAcknowledged`. */}
      <Modal
        visible={policyAcknowledged === false}
        transparent
        animationType="fade"
        onRequestClose={() => {}}
      >
        <View style={styles.policyBackdrop}>
          <View style={styles.policyCard}>
            <Text style={styles.policyTitle}>Before your first swap</Text>
            <Text style={styles.policyBody}>{USAGE_POLICY_TEXT}</Text>
            <TouchableOpacity
              style={styles.policyButton}
              onPress={acceptPolicy}
              disabled={acknowledging}
              activeOpacity={0.8}
            >
              {acknowledging ? (
                <ActivityIndicator color="#09090b" />
              ) : (
                <Text style={styles.policyButtonText}>I Agree — Continue</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Top Header Bar */}
      <View style={styles.topBar}>
        <View style={styles.topBarLeft}>
          <Text style={styles.appTitle}>FaceFusion</Text>
          <Text style={styles.appSub}>Qualcomm Hexagon NPU</Text>
        </View>
        <TouchableOpacity
          style={[
            styles.statusBadge,
            isReady ? styles.badgeReady : styles.badgePending,
          ]}
          onPress={() => setTab('status')}
          activeOpacity={0.7}
        >
          <View
            style={[
              styles.statusDot,
              isReady ? styles.statusDotReady : styles.statusDotPending,
            ]}
          />
          <Text
            style={[
              styles.statusBadgeText,
              isReady ? styles.textReady : styles.textPending,
            ]}
          >
            {isReady ? 'Ready' : 'No Models'}
          </Text>
        </TouchableOpacity>
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
              <View style={styles.noticeDot} />
              <Text style={styles.noticeText}>
                Models not downloaded. Tap here to download.
              </Text>
            </TouchableOpacity>
          )}

          {/* ===== Stage ===== */}
          <View style={styles.stage}>
            {swapping ? (
              // Live, straight from the native Surface -- no pixels over the bridge.
              <View style={styles.stageFill}>
                <FacefusionPreview style={styles.stageFill} />
                <View style={styles.stageLiveBadge}>
                  <View style={styles.livePulseDot} />
                  <Text style={styles.stageLiveBadgeText}>
                    LIVE NPU PREVIEW
                  </Text>
                </View>
              </View>
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
              <View style={styles.stageResultCard}>
                <View style={styles.stageResultBadge}>
                  <Text style={styles.stageResultBadgeText}>
                    VIDEO COMPLETE
                  </Text>
                </View>
                <View style={styles.stageMetricsRow}>
                  <View style={styles.stageMetricBox}>
                    <Text style={styles.stageMetricVal}>
                      {videoResult.frameCount}
                    </Text>
                    <Text style={styles.stageMetricLbl}>Frames</Text>
                  </View>
                  <View style={styles.stageMetricDivider} />
                  <View style={styles.stageMetricBox}>
                    <Text style={styles.stageMetricVal}>
                      {videoResult.fps.toFixed(1)}
                    </Text>
                    <Text style={styles.stageMetricLbl}>FPS</Text>
                  </View>
                  <View style={styles.stageMetricDivider} />
                  <View style={styles.stageMetricBox}>
                    <Text style={styles.stageMetricVal}>
                      {videoResult.tier}
                    </Text>
                    <Text style={styles.stageMetricLbl}>NPU Tier</Text>
                  </View>
                </View>
                <Text style={styles.stagePathText} numberOfLines={1}>
                  Output: {videoResult.outputPath.split('/').pop()}
                </Text>
              </View>
            ) : (
              // Deliberately NOT a preview of the target. Showing the input here made it
              // look like the swap had already run and produced an unchanged picture --
              // the tiles below already show what is selected. The stage stays empty
              // until something has actually been produced.
              <View style={styles.stageEmpty}>
                <View style={styles.viewfinder}>
                  <View style={[styles.cornerBracket, styles.cornerTL]} />
                  <View style={[styles.cornerBracket, styles.cornerTR]} />
                  <View style={[styles.cornerBracket, styles.cornerBL]} />
                  <View style={[styles.cornerBracket, styles.cornerBR]} />
                  <View style={styles.viewfinderCenter}>
                    <View style={styles.viewfinderIconCircle} />
                  </View>
                </View>
                <Text style={styles.stageTitle}>
                  {blocker == null ? 'Ready to Swap' : 'Preview & Results'}
                </Text>
                <Text style={styles.stageHint}>
                  {blocker == null
                    ? 'Tap Run Swap below to generate result'
                    : 'The swapped result will appear here'}
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
                  style={[
                    styles.stageSave,
                    savedUri != null && styles.stageSaveDone,
                  ]}
                  onPress={saveResultToGallery}
                  disabled={saving}
                  activeOpacity={0.8}
                >
                  {saving ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.stageSaveText}>
                      {savedUri != null ? 'Saved to Photos' : 'Save to Gallery'}
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
                    Frame {videoProgress.frameIndex}
                    {videoProgress.estimatedFrameCount > 0
                      ? ` / ~${videoProgress.estimatedFrameCount}`
                      : ''}{' '}
                    · {videoProgress.fps.toFixed(1)} FPS ({videoPercent}%)
                  </Text>
                </View>
                <TouchableOpacity
                  style={styles.stageCancel}
                  onPress={cancelVideoSwap}
                  activeOpacity={0.8}
                >
                  <Text style={styles.cancelButtonText}>Stop</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>

          {(swapError != null || saveError != null) && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText} numberOfLines={2}>
                {swapError ?? saveError}
              </Text>
            </View>
          )}

          {/* ===== Controls ===== */}
          <View style={styles.pairRow}>
            <MediaTile
              step="1"
              label="Source Face"
              path={sourcePath}
              kind="image"
              onPress={pickSource}
              onClear={() => setSourcePath('')}
              faceCount={sourceFaces.length}
            />
            <View style={styles.pairArrowContainer}>
              <Text style={styles.pairArrow}>-&gt;</Text>
            </View>
            <MediaTile
              step="2"
              label={targetIsVideo ? 'Target Clip' : 'Target Media'}
              path={targetPath}
              kind={targetIsVideo ? 'video' : 'image'}
              onPress={pickTarget}
              onClear={() => setTargetPath('')}
              faceCount={targetFaces.length}
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
              defaultLabel="Auto (Largest)"
              title="Select Identity Face"
            />
          )}
          {targetFaces.length > 0 && (
            <FaceStrip
              // A clip's faces come from its first frame, which cannot be rendered here.
              path={targetIsVideo ? null : targetPath}
              faces={targetFaces}
              selected={selectedTargetFaceIndex}
              onSelect={setSelectedTargetFaceIndex}
              defaultLabel="All Faces"
              title="Select Target Face"
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
              <View style={styles.buttonRunningRow}>
                <ActivityIndicator size="small" color="#000000" />
                <Text style={styles.buttonRunningText}>
                  {targetIsVideo ? 'Swapping Video...' : 'Swapping Photo...'}
                </Text>
              </View>
            ) : (
              <View style={styles.buttonContentRow}>
                <View
                  style={[
                    styles.stepButtonBadge,
                    blocker != null && styles.stepButtonBadgeDisabled,
                  ]}
                >
                  <Text
                    style={[
                      styles.stepButtonBadgeText,
                      blocker != null && styles.stepButtonBadgeTextDisabled,
                    ]}
                  >
                    3
                  </Text>
                </View>
                <Text
                  style={[
                    styles.primaryButtonText,
                    blocker != null && styles.buttonDisabledText,
                  ]}
                >
                  {targetIsVideo ? 'Run Video Swap' : 'Run Swap'}
                </Text>
              </View>
            )}
          </TouchableOpacity>

          {blocker != null && !swapping && (
            <View style={styles.blockerCard}>
              <View style={styles.blockerDot} />
              <Text style={styles.blockerText}>{blocker}</Text>
            </View>
          )}

          {/* Everything that is not the main flow, in a refined quick toolbar. */}
          <View style={styles.footerRow}>
            <TouchableOpacity
              style={[
                styles.footerButton,
                (!isReady || sourcePath.trim() === '') &&
                  styles.footerButtonDisabled,
              ]}
              onPress={detectFaces}
              disabled={detectingFaces || !isReady || sourcePath.trim() === ''}
              activeOpacity={0.7}
            >
              {detectingFaces && (
                <ActivityIndicator
                  size="small"
                  color="#38bdf8"
                  style={styles.footerButtonSpinner}
                />
              )}
              <Text
                style={[
                  styles.footerButtonText,
                  (!isReady || sourcePath.trim() === '') &&
                    styles.footerButtonTextDisabled,
                ]}
              >
                {detectingFaces ? 'Scanning...' : 'Detect Source'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.footerButton,
                (!isReady || targetPath.trim() === '') &&
                  styles.footerButtonDisabled,
              ]}
              onPress={detectTargetFacesForPhoto}
              disabled={
                detectingTargetFaces || !isReady || targetPath.trim() === ''
              }
              activeOpacity={0.7}
            >
              {detectingTargetFaces && (
                <ActivityIndicator
                  size="small"
                  color="#38bdf8"
                  style={styles.footerButtonSpinner}
                />
              )}
              <Text
                style={[
                  styles.footerButtonText,
                  (!isReady || targetPath.trim() === '') &&
                    styles.footerButtonTextDisabled,
                ]}
              >
                {detectingTargetFaces ? 'Scanning...' : 'Detect Target'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.footerButton,
                isOptionsModified && styles.footerButtonActive,
              ]}
              onPress={() => setOptionsExpanded(true)}
              activeOpacity={0.7}
            >
              {isOptionsModified && <View style={styles.activeDot} />}
              <Text
                style={[
                  styles.footerButtonText,
                  isOptionsModified && styles.footerButtonTextActive,
                ]}
              >
                Options
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.footerButton}
              onPress={() => setPathsExpanded(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.footerButtonText}>Paths</Text>
            </TouchableOpacity>
          </View>

          {(detectError != null || detectTargetError != null) && (
            <View style={styles.errorBanner}>
              <Text style={styles.errorText} numberOfLines={3}>
                {detectError ?? detectTargetError}
              </Text>
            </View>
          )}

          {/* ===== Advanced options, in a sheet rather than on the screen =====
              These are expert controls and there are eleven of them; inline they were
              most of the screen's height for something a first run never touches. */}
          <Sheet
            visible={optionsExpanded}
            title="Options"
            onClose={() => setOptionsExpanded(false)}
            headerRight={
              isOptionsModified ? (
                <TouchableOpacity
                  onPress={resetOptions}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={styles.resetTouch}
                >
                  <Text style={styles.resetText}>Reset</Text>
                </TouchableOpacity>
              ) : null
            }
          >
            {targetIsVideo && (
              <>
                <Text style={styles.sheetSectionHeader}>Video Processing</Text>
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

            <Text style={styles.sheetSectionHeader}>Identity & Quality</Text>
            <NumberStepper
              label="Blend (source to target identity)"
              value={swapperWeight}
              onChange={setSwapperWeight}
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
              format={(v) => `${v}x (${256 * v}px)`}
            />
            <Separator />

            <Text style={styles.sheetSectionHeader}>Face Detection</Text>
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
            <ToggleRow
              label="Swap largest face only (target)"
              value={largestFaceOnly}
              onChange={setLargestFaceOnly}
            />
            <Separator />

            <Text style={styles.sheetSectionHeader}>Masking</Text>
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
            <Separator />

            <Text style={styles.sheetSectionHeader}>Enhancement</Text>
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
            title="File Paths"
            onClose={() => setPathsExpanded(false)}
          >
            <View style={styles.pathItem}>
              <View style={styles.pathHeaderRow}>
                <Text style={styles.inputLabel}>Source Image</Text>
                {sourcePath.trim() !== '' && (
                  <TouchableOpacity
                    onPress={() => setSourcePath('')}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Text style={styles.pathClearLink}>Clear</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.input}
                value={sourcePath}
                onChangeText={setSourcePath}
                placeholder="The face image to copy from"
                placeholderTextColor="#71717a"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.pathItem}>
              <View style={styles.pathHeaderRow}>
                <Text style={styles.inputLabel}>
                  Target Media (Photo or Video)
                </Text>
                {targetPath.trim() !== '' && (
                  <TouchableOpacity
                    onPress={() => setTargetPath('')}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Text style={styles.pathClearLink}>Clear</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.input}
                value={targetPath}
                onChangeText={setTargetPath}
                placeholder="The photo or clip to change"
                placeholderTextColor="#71717a"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.pathItem}>
              <View style={styles.pathHeaderRow}>
                <Text style={styles.inputLabel}>
                  Output{' '}
                  {outputOverride == null
                    ? '(Following target kind)'
                    : '(Custom)'}
                </Text>
                {outputOverride != null && (
                  <TouchableOpacity
                    onPress={() => setOutputOverride(null)}
                    hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  >
                    <Text style={styles.pathClearLink}>Reset to Default</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.input}
                value={outputPath}
                onChangeText={setOutputOverride}
                placeholder="Where to write the result"
                placeholderTextColor="#71717a"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
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
                {probing && <ActivityIndicator size="small" color="#a1a1aa" />}
              </View>

              {probe == null ? (
                <Text style={styles.mutedText}>Probing device...</Text>
              ) : (
                <>
                  <Row label="Tier" value={probe.tier} />
                  <Separator />
                  <Row label="Chain" value={probe.tierChain.join(' -> ')} />
                  <Separator />
                  <Row label="Verified NPU" value={probe.ok ? 'Yes' : 'No'} />
                  <Separator />
                  <Row
                    label="Architecture"
                    value={probe.ok ? `v${probe.arch}` : 'N/A'}
                  />
                  <Separator />
                  <Row
                    label="VTCM Memory"
                    value={probe.ok ? `${probe.vtcmMb} MB` : 'N/A'}
                  />
                  <Separator />
                  <Row
                    label="SoC ID"
                    value={probe.ok ? String(probe.socModel) : 'N/A'}
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
                <Text style={styles.mutedText}>Checking models...</Text>
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
                  activeOpacity={0.8}
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
                  activeOpacity={0.8}
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
 * `path` is the photo the faces were found in -- when it is null (a video, whose first
 * frame this app has no way to render) the tiles fall back to numbered placeholders,
 * which is what every picker in this app used to be.
 */
function FaceStrip({
  path,
  faces,
  selected,
  onSelect,
  defaultLabel,
  title,
}: {
  path: string | null;
  faces: DetectedFace[];
  selected: number | null;
  onSelect: (index: number | null) => void;
  defaultLabel: string;
  title: string;
}) {
  return (
    <View style={styles.faceStripContainer}>
      <View style={styles.faceStripHeader}>
        <Text style={styles.faceStripTitle}>{title}</Text>
        <Text style={styles.faceStripCount}>
          {faces.length} {faces.length === 1 ? 'face' : 'faces'}
        </Text>
      </View>
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
            <Text style={styles.faceThumbAutoMark}>AUTO</Text>
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
              <FaceThumb path={path} face={face} size={58} />
            ) : (
              <View style={[styles.faceThumb, styles.faceThumbAuto]}>
                <Text style={styles.faceThumbAutoMark}>#{i + 1}</Text>
              </View>
            )}
            <Text style={styles.faceOptionLabel} numberOfLines={1}>
              {(face.score * 100).toFixed(0)}%
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * The source/target picker tile: the picked image itself, or an empty state that says
 * what to do. Replaces a label + "Choose photo..." link + a raw path in a TextInput, which
 * gave no confirmation of *what* had been picked -- the single most confusing thing about
 * the old screen, since a wrong pick looked identical to a right one.
 */
function MediaTile({
  step,
  label,
  path,
  kind,
  onPress,
  onClear,
  faceCount,
}: {
  step: string;
  label: string;
  path: string;
  kind: 'image' | 'video';
  onPress: () => void;
  onClear?: () => void;
  faceCount?: number;
}) {
  const filled = path.trim() !== '';
  const fileName = filled ? path.split('/').pop() : '';

  return (
    <View style={styles.tile}>
      <TouchableOpacity
        style={[styles.tileFrame, filled && styles.tileFrameFilled]}
        onPress={onPress}
        activeOpacity={0.8}
      >
        {filled && kind === 'image' ? (
          <Image
            source={{ uri: `file://${path}` }}
            style={styles.tileImage}
            resizeMode="cover"
          />
        ) : filled && kind === 'video' ? (
          <View style={styles.tileVideoPreview}>
            <View style={styles.videoPill}>
              <Text style={styles.videoPillText}>VIDEO</Text>
            </View>
            <Text style={styles.tileFileName} numberOfLines={2}>
              {fileName}
            </Text>
            <Text style={styles.tileTapHint}>Tap to change</Text>
          </View>
        ) : (
          <View style={styles.tileEmpty}>
            <View style={styles.tilePlusCircle}>
              <Text style={styles.tilePlusText}>+</Text>
            </View>
            <Text style={styles.tileEmptyAction}>
              {kind === 'video' ? 'Select Media' : 'Select Photo'}
            </Text>
            <Text style={styles.tileEmptySub}>Tap to browse</Text>
          </View>
        )}

        {filled && faceCount != null && faceCount > 0 && (
          <View style={styles.faceCountBadge}>
            <Text style={styles.faceCountBadgeText}>
              {faceCount} {faceCount === 1 ? 'face' : 'faces'}
            </Text>
          </View>
        )}
      </TouchableOpacity>

      <View style={styles.tileCaptionRow}>
        <View style={styles.tileCaptionLeft}>
          <View style={styles.tileStepBadge}>
            <Text style={styles.tileStepText}>{step}</Text>
          </View>
          <Text style={styles.tileLabel} numberOfLines={1}>
            {label}
          </Text>
        </View>
        {filled && onClear && (
          <TouchableOpacity
            onPress={onClear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.tileClearText}>Clear</Text>
          </TouchableOpacity>
        )}
      </View>
      {filled && (
        <TouchableOpacity
          onPress={onPress}
          hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
        >
          <Text style={styles.tileAction}>Change</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * A bottom sheet for the things that are not the main flow -- advanced options, raw
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
  headerRight,
  children,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  headerRight?: React.ReactNode;
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
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <View style={styles.sheetHeaderRight}>
              {headerRight}
              <TouchableOpacity
                onPress={onClose}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                style={styles.sheetDoneButton}
              >
                <Text style={styles.sheetDone}>Done</Text>
              </TouchableOpacity>
            </View>
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
 *  project doesn't otherwise need) - a stepper is one fewer dependency for the same knob. */
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
  const canDec = value > min;
  const canInc = value < max;

  return (
    <View style={styles.stepperRow}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.stepperControls}>
        <TouchableOpacity
          style={[
            styles.stepperButton,
            !canDec && styles.stepperButtonDisabled,
          ]}
          onPress={() => onChange(clamp(value - step))}
          disabled={!canDec}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text
            style={[
              styles.stepperButtonText,
              !canDec && styles.stepperButtonTextDisabled,
            ]}
          >
            -
          </Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>
          {format ? format(value) : value.toFixed(2)}
        </Text>
        <TouchableOpacity
          style={[
            styles.stepperButton,
            !canInc && styles.stepperButtonDisabled,
          ]}
          onPress={() => onChange(clamp(value + step))}
          disabled={!canInc}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text
            style={[
              styles.stepperButtonText,
              !canInc && styles.stepperButtonTextDisabled,
            ]}
          >
            +
          </Text>
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
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: '#27272a', true: '#0a84ff' }}
        thumbColor={value ? '#ffffff' : '#a1a1aa'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#09090b',
    // No manual StatusBar.currentHeight padding any more -- SafeAreaView supplies the
    // real inset on both edges, and doing both double-padded the top.
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 10,
  },
  topBarLeft: {
    gap: 1,
  },
  appTitle: {
    fontSize: 21,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.4,
  },
  appSub: {
    fontSize: 12,
    color: '#71717a',
    fontWeight: '500',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: 1,
  },
  badgeReady: {
    backgroundColor: 'rgba(34, 197, 94, 0.12)',
    borderColor: 'rgba(34, 197, 94, 0.25)',
  },
  badgePending: {
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.25)',
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusDotReady: {
    backgroundColor: '#22c55e',
  },
  statusDotPending: {
    backgroundColor: '#f59e0b',
  },
  statusBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  textReady: {
    color: '#22c55e',
  },
  textPending: {
    color: '#f59e0b',
  },
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: '#18181b',
    borderRadius: 10,
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
  },
  segment: {
    flex: 1,
    paddingVertical: 7,
    alignItems: 'center',
    borderRadius: 8,
  },
  segmentActive: {
    backgroundColor: '#27272a',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 2,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#71717a',
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(245, 158, 11, 0.12)',
    borderColor: 'rgba(245, 158, 11, 0.28)',
    borderWidth: 1,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 9,
  },
  noticeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f59e0b',
  },
  noticeText: {
    fontSize: 12,
    color: '#f59e0b',
    textAlign: 'center',
    fontWeight: '600',
  },
  card: {
    backgroundColor: '#18181b',
    borderRadius: 14,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
  },
  cardHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  cardTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#a1a1aa',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  stepButtonBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepButtonBadgeDisabled: {
    backgroundColor: '#3f3f46',
  },
  stepButtonBadgeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#ffffff',
    lineHeight: 14,
  },
  stepButtonBadgeTextDisabled: {
    color: '#71717a',
  },
  buttonContentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonRunningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  buttonRunningText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
  },
  blockerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(245, 158, 11, 0.2)',
  },
  blockerDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#f59e0b',
  },
  blockerText: {
    fontSize: 12,
    color: '#f59e0b',
    fontWeight: '500',
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#a1a1aa',
  },
  input: {
    backgroundColor: '#18181b',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    fontSize: 13,
    color: '#ffffff',
    fontVariant: ['tabular-nums'],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
  },
  pathItem: {
    marginBottom: 14,
  },
  pathHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 6,
  },
  pathClearLink: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0a84ff',
  },
  primaryButton: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 3,
  },
  secondaryButton: {
    backgroundColor: '#27272a',
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  buttonDisabled: {
    backgroundColor: '#1c1c1f',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
    elevation: 0,
    shadowOpacity: 0,
  },
  buttonDisabledText: {
    color: '#71717a',
  },
  primaryButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: -0.2,
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  },
  cancelButton: {
    backgroundColor: '#2e1212',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  cancelButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ef4444',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  label: {
    fontSize: 13,
    color: '#a1a1aa',
    fontWeight: '400',
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
    color: '#22c55e',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#27272a',
    marginVertical: 4,
  },
  mutedText: {
    fontSize: 13,
    color: '#71717a',
    paddingVertical: 4,
  },
  errorBanner: {
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  errorText: {
    fontSize: 12,
    color: '#ef4444',
    fontWeight: '500',
  },
  resultChips: {
    flexDirection: 'row',
    gap: 6,
  },
  resultChip: {
    fontSize: 11,
    fontWeight: '600',
    color: '#a1a1aa',
    backgroundColor: '#27272a',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3f3f46',
  },
  progressBox: {
    marginTop: 12,
  },
  progressBarTrack: {
    height: 5,
    backgroundColor: '#27272a',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#0a84ff',
    borderRadius: 3,
  },
  progressText: {
    fontSize: 11,
    color: '#a1a1aa',
    marginTop: 6,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
  },
  stepperRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 7,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepperButton: {
    width: 34,
    height: 34,
    borderRadius: 8,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3f3f46',
  },
  stepperButtonDisabled: {
    opacity: 0.35,
  },
  stepperButtonText: {
    fontSize: 17,
    fontWeight: '600',
    color: '#ffffff',
    lineHeight: 18,
  },
  stepperButtonTextDisabled: {
    color: '#71717a',
  },
  stepperValue: {
    fontSize: 13,
    color: '#ffffff',
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 60,
    textAlign: 'center',
  },
  // ===== Source -> target pair =====
  pairRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pairArrowContainer: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#18181b',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  pairArrow: {
    fontSize: 11,
    color: '#71717a',
    fontWeight: '700',
  },
  tile: {
    flex: 1,
  },
  tileFrame: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: 13,
    overflow: 'hidden',
    backgroundColor: '#18181b',
    borderWidth: 1,
    borderColor: '#27272a',
  },
  tileFrameFilled: {
    borderColor: '#3f3f46',
  },
  tileImage: {
    width: '100%',
    height: '100%',
  },
  tileVideoPreview: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 10,
    gap: 6,
    backgroundColor: '#121214',
  },
  videoPill: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 5,
  },
  videoPillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.5,
  },
  tileFileName: {
    fontSize: 11,
    color: '#ffffff',
    fontWeight: '500',
    textAlign: 'center',
  },
  tileTapHint: {
    fontSize: 10,
    color: '#71717a',
    fontWeight: '400',
  },
  tileEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingHorizontal: 8,
  },
  tilePlusCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#27272a',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tilePlusText: {
    fontSize: 18,
    color: '#ffffff',
    fontWeight: '400',
    lineHeight: 19,
  },
  tileEmptyAction: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
    textAlign: 'center',
  },
  tileEmptySub: {
    fontSize: 10,
    color: '#71717a',
    textAlign: 'center',
  },
  faceCountBadge: {
    position: 'absolute',
    top: 6,
    right: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3f3f46',
  },
  faceCountBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#38bdf8',
  },
  tileCaptionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 6,
  },
  tileCaptionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  tileStepBadge: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(10, 132, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileStepText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0a84ff',
    lineHeight: 12,
  },
  tileLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
    flexShrink: 1,
  },
  tileClearText: {
    fontSize: 11,
    color: '#71717a',
    fontWeight: '500',
  },
  tileAction: {
    fontSize: 11,
    color: '#0a84ff',
    fontWeight: '500',
    marginTop: 1,
  },
  // ===== Face picker =====
  faceStripContainer: {
    gap: 6,
  },
  faceStripHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  faceStripTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#a1a1aa',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  faceStripCount: {
    fontSize: 11,
    color: '#71717a',
    fontWeight: '500',
  },
  faceStrip: {
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 2,
  },
  faceOption: {
    alignItems: 'center',
    padding: 3,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: 'transparent',
    width: 68,
  },
  faceOptionSelected: {
    borderColor: '#0a84ff',
    backgroundColor: 'rgba(10, 132, 255, 0.12)',
  },
  faceOptionLabel: {
    fontSize: 10,
    color: '#a1a1aa',
    marginTop: 3,
    fontVariant: ['tabular-nums'],
    fontWeight: '500',
  },
  faceThumb: {
    width: 58,
    height: 58,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#27272a',
  },
  faceThumbImage: {
    position: 'absolute',
  },
  faceThumbAuto: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3f3f46',
  },
  faceThumbAutoMark: {
    fontSize: 12,
    fontWeight: '700',
    color: '#a1a1aa',
    letterSpacing: 0.5,
  },
  // ===== Single-screen swap layout =====
  // No ScrollView: the stage takes the slack (`flex: 1`) and the controls under it are
  // their own natural height, so the whole job fits one screen at any device height.
  swapScreen: {
    flex: 1,
    paddingHorizontal: 16,
    paddingBottom: 8,
    gap: 8,
  },
  stage: {
    flex: 1,
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#121214',
    borderWidth: 1,
    borderColor: '#27272a',
    justifyContent: 'center',
  },
  stageFill: {
    width: '100%',
    height: '100%',
  },
  stageLiveBadge: {
    position: 'absolute',
    top: 10,
    left: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3f3f46',
  },
  livePulseDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#22c55e',
  },
  stageLiveBadgeText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: 0.6,
  },
  stageResultCard: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
    gap: 12,
  },
  stageResultBadge: {
    backgroundColor: 'rgba(34, 197, 94, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(34, 197, 94, 0.3)',
  },
  stageResultBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#22c55e',
    letterSpacing: 0.8,
  },
  stageMetricsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#18181b',
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
    gap: 16,
  },
  stageMetricBox: {
    alignItems: 'center',
    minWidth: 50,
  },
  stageMetricVal: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    fontVariant: ['tabular-nums'],
  },
  stageMetricLbl: {
    fontSize: 10,
    color: '#71717a',
    fontWeight: '500',
    marginTop: 2,
  },
  stageMetricDivider: {
    width: StyleSheet.hairlineWidth,
    height: 24,
    backgroundColor: '#27272a',
  },
  stagePathText: {
    fontSize: 11,
    color: '#71717a',
    fontVariant: ['tabular-nums'],
  },
  stageEmpty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  viewfinder: {
    width: 64,
    height: 64,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 4,
  },
  cornerBracket: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderColor: '#3f3f46',
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderTopLeftRadius: 4,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderTopRightRadius: 4,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderBottomLeftRadius: 4,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderBottomRightRadius: 4,
  },
  viewfinderCenter: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewfinderIconCircle: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#27272a',
  },
  stageTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
  stageHint: {
    fontSize: 12,
    color: '#71717a',
    textAlign: 'center',
  },
  // Overlaid rather than stacked, so showing a result costs the stage no height.
  stageBar: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: 'rgba(18, 18, 20, 0.85)',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3f3f46',
  },
  stageSave: {
    backgroundColor: '#0a84ff',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 8,
  },
  stageSaveDone: {
    backgroundColor: '#22c55e',
  },
  stageSaveText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  stageCancel: {
    backgroundColor: '#2e1212',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
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
    gap: 6,
  },
  footerButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#18181b',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#27272a',
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: 8,
    gap: 4,
    minHeight: 34,
  },
  footerButtonDisabled: {
    opacity: 0.4,
  },
  footerButtonActive: {
    borderColor: '#0a84ff',
    backgroundColor: 'rgba(10, 132, 255, 0.1)',
  },
  footerButtonSpinner: {
    marginRight: 2,
  },
  footerButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#a1a1aa',
  },
  footerButtonTextDisabled: {
    color: '#71717a',
  },
  footerButtonTextActive: {
    color: '#0a84ff',
  },
  activeDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: '#0a84ff',
  },
  // ===== Sheet =====
  policyBackdrop: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    padding: 24,
  },
  policyCard: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: '#18181b',
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#27272a',
    padding: 22,
  },
  policyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
    marginBottom: 10,
  },
  policyBody: {
    fontSize: 14,
    lineHeight: 20,
    color: '#a1a1aa',
    marginBottom: 18,
  },
  policyButton: {
    backgroundColor: '#ffffff',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  policyButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: -0.2,
  },
  sheetBackdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  sheetDismissArea: {
    flex: 1,
  },
  sheet: {
    backgroundColor: '#18181b',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 18,
    paddingBottom: 28,
    maxHeight: '80%',
    borderWidth: 1,
    borderColor: '#27272a',
  },
  sheetHandle: {
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#3f3f46',
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  sheetHeaderRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.3,
  },
  sheetDoneButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  sheetDone: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0a84ff',
  },
  resetTouch: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  resetText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#f59e0b',
  },
  sheetSectionHeader: {
    fontSize: 11,
    fontWeight: '700',
    color: '#71717a',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    marginTop: 14,
    marginBottom: 4,
  },
  sheetBody: {
    marginBottom: 8,
  },
});
