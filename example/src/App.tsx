import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  LayoutAnimation,
  Modal,
  NativeModules,
  PermissionsAndroid,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
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
const DEFAULT_VIDEO_TARGET = '';

// Outputs keep a real default: nobody should have to type a path for a file the app
// is about to write itself.
const DEFAULT_OUTPUT = `${FILES_DIR}/swapped.jpg`;
const DEFAULT_VIDEO_OUTPUT = `${FILES_DIR}/swapped.mp4`;

/**
 * Opens the system document picker via the example app's own `MediaPickerModule`
 * (`example/android/.../MediaPickerModule.kt` — not part of the library) and resolves with
 * a real filesystem path, or `null` if the user backed out. Requests the granular media
 * permission first; `ACTION_OPEN_DOCUMENT` does not actually need it (the Storage Access
 * Framework grants the one picked file regardless), but it's asked for anyway so a denial
 * shows up before the picker rather than as a confusing native rejection.
 */
async function pickMedia(kind: 'image' | 'video'): Promise<string | null> {
  if (Platform.OS === 'android') {
    const permission =
      kind === 'video'
        ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_VIDEO
        : PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES;
    await PermissionsAndroid.request(permission);
  }
  try {
    return await NativeModules.MediaPicker.pickMedia(kind);
  } catch {
    return null; // cancelled, or nothing selected
  }
}

function toUri(path: string): string {
  if (!path) return '';
  return path.startsWith('file://') || path.startsWith('content://')
    ? path
    : `file://${path}`;
}

export default function App() {
  const [swapMode, setSwapMode] = useState<'photo' | 'video'>('photo');
  const [showPaths, setShowPaths] = useState(false);
  const [showOptionsSheet, setShowOptionsSheet] = useState(false);
  const [showDeviceSheet, setShowDeviceSheet] = useState(false);

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
  const [outputPath, setOutputPath] = useState(DEFAULT_OUTPUT);
  const [swapping, setSwapping] = useState(false);
  const [swapResult, setSwapResult] = useState<SwapPhotoResult | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  // "Save to Gallery" for the photo result -- copies swapResult.outputPath (the app's own
  // private storage) into MediaStore, since that's the only door into shared storage other
  // apps and the user's own Photos app can see. Cleared whenever a new swap starts, since a
  // saved-URI toast belongs to the swap that produced it, not the next one.
  const [savingPhoto, setSavingPhoto] = useState(false);
  const [savedPhotoUri, setSavedPhotoUri] = useState<string | null>(null);
  const [savePhotoError, setSavePhotoError] = useState<string | null>(null);

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

  // Video swap state
  const [videoTargetPath, setVideoTargetPath] = useState(DEFAULT_VIDEO_TARGET);
  const [videoOutputPath, setVideoOutputPath] = useState(DEFAULT_VIDEO_OUTPUT);
  const [videoSwapping, setVideoSwapping] = useState(false);
  const [videoProgress, setVideoProgress] = useState<VideoSwapProgress | null>(
    null
  );
  const [videoResult, setVideoResult] = useState<SwapVideoResult | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  // "Save to Gallery" for the video result -- same idea as the photo one above.
  const [savingVideo, setSavingVideo] = useState(false);
  const [savedVideoUri, setSavedVideoUri] = useState<string | null>(null);
  const [saveVideoError, setSaveVideoError] = useState<string | null>(null);

  // Target face picker (video) — same idea as the photo one above, detected from the
  // clip's first frame (already upright — see TargetFaces.kt). A separate selection from
  // the photo target's, since it's a different path.
  const [videoTargetFaces, setVideoTargetFaces] = useState<DetectedFace[]>([]);
  const [detectingVideoTargetFaces, setDetectingVideoTargetFaces] =
    useState(false);
  const [detectVideoTargetError, setDetectVideoTargetError] = useState<
    string | null
  >(null);
  const [selectedVideoTargetFaceIndex, setSelectedVideoTargetFaceIndex] =
    useState<number | null>(null);

  // Video FPS cap — set before running the swap, per Saad's own framing. Off by default
  // (every frame, unchanged behaviour); when on, only `targetFpsValue` of the source's own
  // frames actually get swapped and encoded, the rest decoded and dropped. See ADR-0014.
  const [fpsCapEnabled, setFpsCapEnabled] = useState(false);
  const [targetFpsValue, setTargetFpsValue] = useState(15);

  // Advanced swap options — every one of these already exists on the native side
  // (SwapConfig.kt, ffpipe::Config) and was already accepted by swapPhoto()/swapVideo();
  // this is the first UI for any of them. Defaults match SwapConfig's own Kotlin defaults.
  // Shared between the photo and video cards below, since both take the same SwapOptions.
  const [swapperWeight, setSwapperWeight] = useState(0.5);
  const [maskBlur, setMaskBlur] = useState(0.3);
  const [maskPadding, setMaskPadding] = useState(0); // one uniform value, all 4 sides
  const [detectorScore, setDetectorScore] = useState(0.5);
  const [landmarkerScore, setLandmarkerScore] = useState(0.5);
  const [pixelBoost, setPixelBoost] = useState(1);
  const [largestFaceOnly, setLargestFaceOnly] = useState(false);
  const [faceEnhance, setFaceEnhance] = useState(false);
  const [faceEnhancerBlend, setFaceEnhancerBlend] = useState(0.8);

  const toggleFaceEnhance = useCallback((value: boolean) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setFaceEnhance(value);
  }, []);

  const selectedFace =
    selectedFaceIndex != null ? sourceFaces[selectedFaceIndex] : undefined;
  const selectedTargetFace =
    selectedTargetFaceIndex != null
      ? targetFaces[selectedTargetFaceIndex]
      : undefined;
  const selectedVideoTargetFace =
    selectedVideoTargetFaceIndex != null
      ? videoTargetFaces[selectedVideoTargetFaceIndex]
      : undefined;

  const faceBox = (f: DetectedFace | undefined) =>
    f ? [f.left, f.top, f.right, f.bottom] : undefined;

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

  const photoSwapOptions: SwapOptions = useMemo(
    () => ({ ...commonOptions, targetFaceBox: faceBox(selectedTargetFace) }),
    [commonOptions, selectedTargetFace]
  );

  const videoSwapOptions: SwapOptions = useMemo(
    () => ({
      ...commonOptions,
      targetFaceBox: faceBox(selectedVideoTargetFace),
      targetFps: fpsCapEnabled ? targetFpsValue : undefined,
    }),
    [commonOptions, selectedVideoTargetFace, fpsCapEnabled, targetFpsValue]
  );

  // A detected-faces list belongs to one specific photo — stale results pointing at a
  // different image would silently swap the wrong face in.
  useEffect(() => {
    setSourceFaces([]);
    setSelectedFaceIndex(null);
    setDetectError(null);
  }, [sourcePath]);

  const detectFaces = useCallback(() => {
    setDetectError(null);
    setSelectedFaceIndex(null);
    setDetectingFaces(true);
    detectSourceFaces(sourcePath)
      .then(setSourceFaces)
      .catch((e: Error) => setDetectError(e.message))
      .finally(() => setDetectingFaces(false));
  }, [sourcePath]);

  // A detected-faces list belongs to one specific target -- stale results pointing at a
  // different photo would silently swap the wrong face.
  useEffect(() => {
    setTargetFaces([]);
    setSelectedTargetFaceIndex(null);
    setDetectTargetError(null);
  }, [targetPath]);

  const detectTargetFacesForPhoto = useCallback(() => {
    setDetectTargetError(null);
    setSelectedTargetFaceIndex(null);
    setDetectingTargetFaces(true);
    detectTargetFaces(targetPath)
      .then(setTargetFaces)
      .catch((e: Error) => setDetectTargetError(e.message))
      .finally(() => setDetectingTargetFaces(false));
  }, [targetPath]);

  useEffect(() => {
    setVideoTargetFaces([]);
    setSelectedVideoTargetFaceIndex(null);
    setDetectVideoTargetError(null);
  }, [videoTargetPath]);

  const detectTargetFacesForVideo = useCallback(() => {
    setDetectVideoTargetError(null);
    setSelectedVideoTargetFaceIndex(null);
    setDetectingVideoTargetFaces(true);
    detectTargetFaces(videoTargetPath)
      .then(setVideoTargetFaces)
      .catch((e: Error) => setDetectVideoTargetError(e.message))
      .finally(() => setDetectingVideoTargetFaces(false));
  }, [videoTargetPath]);

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

  const swap = useCallback(() => {
    setSwapError(null);
    setSwapResult(null);
    setSavedPhotoUri(null);
    setSavePhotoError(null);
    setSwapping(true);
    swapPhoto(sourcePath, targetPath, outputPath, photoSwapOptions)
      .then(setSwapResult)
      .catch((e: Error) => setSwapError(e.message))
      .finally(() => setSwapping(false));
  }, [sourcePath, targetPath, outputPath, photoSwapOptions]);

  const swapVid = useCallback(() => {
    setVideoError(null);
    setVideoResult(null);
    setVideoProgress(null);
    setSavedVideoUri(null);
    setSaveVideoError(null);
    setVideoSwapping(true);
    swapVideo(sourcePath, videoTargetPath, videoOutputPath, videoSwapOptions)
      .then(setVideoResult)
      .catch((e: Error) => setVideoError(e.message))
      .finally(() => setVideoSwapping(false));
  }, [sourcePath, videoTargetPath, videoOutputPath, videoSwapOptions]);

  // outputPath's own extension decides the mime type here, same as PhotoSwap.write()'s own
  // PNG/JPEG choice -- this is example-app glue, not the library, so it's fine to be this
  // simple rather than accept a mimeType from the UI.
  const saveSwapToGallery = useCallback(() => {
    if (swapResult == null) return;
    setSavePhotoError(null);
    setSavingPhoto(true);
    const mimeType = swapResult.outputPath.toLowerCase().endsWith('.png')
      ? 'image/png'
      : 'image/jpeg';
    saveToGallery(swapResult.outputPath, mimeType)
      .then(setSavedPhotoUri)
      .catch((e: Error) => setSavePhotoError(e.message))
      .finally(() => setSavingPhoto(false));
  }, [swapResult]);

  const saveVideoToGallery = useCallback(() => {
    if (videoResult == null) return;
    setSaveVideoError(null);
    setSavingVideo(true);
    saveToGallery(videoResult.outputPath, 'video/mp4')
      .then(setSavedVideoUri)
      .catch((e: Error) => setSaveVideoError(e.message))
      .finally(() => setSavingVideo(false));
  }, [videoResult]);

  const pickSource = useCallback(() => {
    pickMedia('image').then((path) => path && setSourcePath(path));
  }, []);

  const pickTarget = useCallback(() => {
    pickMedia('image').then((path) => path && setTargetPath(path));
  }, []);

  const pickVideoTarget = useCallback(() => {
    pickMedia('video').then((path) => path && setVideoTargetPath(path));
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
  const photoBlocker = !isReady
    ? 'Download the models first — see Device & Models.'
    : sourcePath.trim() === ''
      ? 'Choose a source face in step 1.'
      : targetPath.trim() === ''
        ? 'Choose a target photo in step 2.'
        : null;

  const videoBlocker = !isReady
    ? 'Download the models first — see Device & Models.'
    : sourcePath.trim() === ''
      ? 'Choose a source face in step 1.'
      : videoTargetPath.trim() === ''
        ? 'Choose a target video in step 2.'
        : null;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar
        barStyle="light-content"
        backgroundColor="#000000"
        translucent={false}
      />

      {/* Top Header Bar */}
      <View style={styles.topBar}>
        <View>
          <Text style={styles.appTitle}>FaceFusion</Text>
          <Text style={styles.appSub}>Qualcomm Hexagon NPU</Text>
        </View>
        <View style={styles.topBarRight}>
          <TouchableOpacity
            style={styles.deviceButton}
            onPress={() => setShowDeviceSheet(true)}
            activeOpacity={0.7}
          >
            <Text style={styles.deviceButtonText}>Device & Models</Text>
          </TouchableOpacity>
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
      </View>

      {/* Main Content */}
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentInner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.tabPane}>
          {!isReady && (
            <TouchableOpacity
              style={styles.noticeBar}
              onPress={() => setShowDeviceSheet(true)}
              activeOpacity={0.7}
            >
              <Text style={styles.noticeText}>
                Models not downloaded. Tap here to manage models.
              </Text>
            </TouchableOpacity>
          )}

          {/* Mode Switcher: Photo vs Video */}
          <View style={styles.swapModeBar}>
            <TouchableOpacity
              style={[
                styles.modeTab,
                swapMode === 'photo' && styles.modeTabActive,
              ]}
              onPress={() => setSwapMode('photo')}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.modeTabText,
                  swapMode === 'photo' && styles.modeTabTextActive,
                ]}
              >
                Photo Swap
              </Text>
              {swapping && <View style={styles.runningBadge} />}
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.modeTab,
                swapMode === 'video' && styles.modeTabActive,
              ]}
              onPress={() => setSwapMode('video')}
              activeOpacity={0.7}
            >
              <Text
                style={[
                  styles.modeTabText,
                  swapMode === 'video' && styles.modeTabTextActive,
                ]}
              >
                Video Swap
              </Text>
              {videoSwapping && <View style={styles.runningBadge} />}
            </TouchableOpacity>
          </View>

          {swapMode === 'photo' ? (
            /* ============= PHOTO SWAP VIEW ============= */
            <>
              <View style={styles.card}>
                <View style={styles.boxHeader}>
                  <View style={styles.boxTitleRow}>
                    <Text style={styles.boxTitle}>Photo Swap</Text>
                    <View style={styles.badgeTag}>
                      <Text style={styles.badgeTagText}>SINGLE IMAGE</Text>
                    </View>
                  </View>
                  <Text style={styles.hint}>
                    The face from step 1 replaces the face in step 2.
                  </Text>
                </View>

                {/* Dual Media Preview Row (Side-by-Side) */}
                <View style={styles.dualMediaRow}>
                  {/* Source Media Column (Step 1) */}
                  <View style={styles.mediaCol}>
                    <View style={styles.stepHeaderRow}>
                      <View style={styles.stepTitleGroup}>
                        <View style={styles.stepBadge}>
                          <Text style={styles.stepBadgeNumber}>1</Text>
                        </View>
                        <Text style={styles.stepTitle}>Source Face</Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.mediaSlot}
                      onPress={pickSource}
                      activeOpacity={0.8}
                    >
                      {sourcePath ? (
                        <>
                          <Image
                            source={{ uri: toUri(sourcePath) }}
                            style={styles.mediaImage}
                            resizeMode="cover"
                          />
                          <View style={styles.changeOverlay}>
                            <Text style={styles.changeOverlayText}>Change</Text>
                          </View>
                        </>
                      ) : (
                        <View style={styles.placeholderBox}>
                          <View style={styles.placeholderIconCircle}>
                            <Text style={styles.placeholderPlus}>+</Text>
                          </View>
                          <Text style={styles.placeholderMain}>
                            Source Face
                          </Text>
                          <Text style={styles.placeholderSub}>
                            Tap to choose
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>

                    {/* Detect Faces Button */}
                    <TouchableOpacity
                      style={styles.compactDetectButton}
                      onPress={detectFaces}
                      disabled={detectingFaces || !isReady || !sourcePath}
                      activeOpacity={0.7}
                    >
                      {detectingFaces ? (
                        <ActivityIndicator size="small" color="#0a84ff" />
                      ) : (
                        <Text style={styles.compactDetectButtonText}>
                          Detect Faces
                        </Text>
                      )}
                    </TouchableOpacity>

                    {detectError != null && (
                      <View style={styles.compactErrorBox}>
                        <Text style={styles.compactErrorText}>
                          {detectError}
                        </Text>
                      </View>
                    )}

                    {sourceFaces.length > 0 && (
                      <View style={styles.facePillWrap}>
                        <TouchableOpacity
                          style={[
                            styles.facePillCompact,
                            selectedFaceIndex === null &&
                              styles.facePillSelected,
                          ]}
                          onPress={() => setSelectedFaceIndex(null)}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.facePillTextCompact,
                              selectedFaceIndex === null &&
                                styles.facePillTextSelected,
                            ]}
                          >
                            Largest
                          </Text>
                        </TouchableOpacity>
                        {sourceFaces.map((face, i) => (
                          <TouchableOpacity
                            key={i}
                            style={[
                              styles.facePillCompact,
                              selectedFaceIndex === i &&
                                styles.facePillSelected,
                            ]}
                            onPress={() => setSelectedFaceIndex(i)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={[
                                styles.facePillTextCompact,
                                selectedFaceIndex === i &&
                                  styles.facePillTextSelected,
                              ]}
                            >
                              F{i + 1} ({(face.score * 100).toFixed(0)}%)
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>

                  {/* Arrow Divider */}
                  <View style={styles.arrowCol}>
                    <View style={styles.arrowBadge}>
                      <Text style={styles.arrowChar}>TO</Text>
                    </View>
                  </View>

                  {/* Target Media Column (Step 2) */}
                  <View style={styles.mediaCol}>
                    <View style={styles.stepHeaderRow}>
                      <View style={styles.stepTitleGroup}>
                        <View style={styles.stepBadge}>
                          <Text style={styles.stepBadgeNumber}>2</Text>
                        </View>
                        <Text style={styles.stepTitle}>Target Photo</Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.mediaSlot}
                      onPress={pickTarget}
                      activeOpacity={0.8}
                    >
                      {targetPath ? (
                        <>
                          <Image
                            source={{ uri: toUri(targetPath) }}
                            style={styles.mediaImage}
                            resizeMode="cover"
                          />
                          <View style={styles.changeOverlay}>
                            <Text style={styles.changeOverlayText}>Change</Text>
                          </View>
                        </>
                      ) : (
                        <View style={styles.placeholderBox}>
                          <View style={styles.placeholderIconCircle}>
                            <Text style={styles.placeholderPlus}>+</Text>
                          </View>
                          <Text style={styles.placeholderMain}>
                            Target Photo
                          </Text>
                          <Text style={styles.placeholderSub}>
                            Tap to choose
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>

                    {/* Detect Faces Button */}
                    <TouchableOpacity
                      style={styles.compactDetectButton}
                      onPress={detectTargetFacesForPhoto}
                      disabled={detectingTargetFaces || !isReady || !targetPath}
                      activeOpacity={0.7}
                    >
                      {detectingTargetFaces ? (
                        <ActivityIndicator size="small" color="#0a84ff" />
                      ) : (
                        <Text style={styles.compactDetectButtonText}>
                          Detect Faces
                        </Text>
                      )}
                    </TouchableOpacity>

                    {detectTargetError != null && (
                      <View style={styles.compactErrorBox}>
                        <Text style={styles.compactErrorText}>
                          {detectTargetError}
                        </Text>
                      </View>
                    )}

                    {targetFaces.length > 0 && (
                      <View style={styles.facePillWrap}>
                        <TouchableOpacity
                          style={[
                            styles.facePillCompact,
                            selectedTargetFaceIndex === null &&
                              styles.facePillSelected,
                          ]}
                          onPress={() => setSelectedTargetFaceIndex(null)}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.facePillTextCompact,
                              selectedTargetFaceIndex === null &&
                                styles.facePillTextSelected,
                            ]}
                          >
                            All
                          </Text>
                        </TouchableOpacity>
                        {targetFaces.map((face, i) => (
                          <TouchableOpacity
                            key={i}
                            style={[
                              styles.facePillCompact,
                              selectedTargetFaceIndex === i &&
                                styles.facePillSelected,
                            ]}
                            onPress={() => setSelectedTargetFaceIndex(i)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={[
                                styles.facePillTextCompact,
                                selectedTargetFaceIndex === i &&
                                  styles.facePillTextSelected,
                              ]}
                            >
                              F{i + 1} ({(face.score * 100).toFixed(0)}%)
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                </View>

                {/* Collapsible custom path options */}
                <TouchableOpacity
                  style={styles.pathsToggle}
                  onPress={() => setShowPaths((v) => !v)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pathsToggleText}>
                    {showPaths ? 'Hide file paths' : 'Show file paths'}
                  </Text>
                </TouchableOpacity>

                {showPaths && (
                  <View style={styles.pathsContainer}>
                    <Text style={styles.inputLabel}>Source Path</Text>
                    <TextInput
                      style={styles.input}
                      value={sourcePath}
                      onChangeText={setSourcePath}
                      placeholder="Source path"
                      placeholderTextColor="#636366"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={styles.inputLabel}>Target Path</Text>
                    <TextInput
                      style={styles.input}
                      value={targetPath}
                      onChangeText={setTargetPath}
                      placeholder="Target path"
                      placeholderTextColor="#636366"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={styles.inputLabel}>Output Path</Text>
                    <TextInput
                      style={styles.input}
                      value={outputPath}
                      onChangeText={setOutputPath}
                      placeholder="where to write the result"
                      placeholderTextColor="#636366"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                )}

                {/* Step 3: Run Swap Button */}
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    (swapping || photoBlocker != null) && styles.buttonDisabled,
                  ]}
                  onPress={swap}
                  disabled={swapping || photoBlocker != null}
                  activeOpacity={0.8}
                >
                  {swapping ? (
                    <ActivityIndicator size="small" color="#000000" />
                  ) : (
                    <Text style={styles.primaryButtonText}>3 Run Swap</Text>
                  )}
                </TouchableOpacity>

                {photoBlocker != null && !swapping && (
                  <View style={styles.blockerCard}>
                    <Text style={styles.blockerText}>{photoBlocker}</Text>
                  </View>
                )}
              </View>

              {/* Live Preview */}
              {swapping && (
                <View style={styles.card}>
                  <View style={styles.previewHeaderRow}>
                    <Text style={styles.cardTitle}>Live Preview</Text>
                    <View style={styles.liveIndicator}>
                      <View style={styles.liveDot} />
                      <Text style={styles.liveText}>PROCESSING</Text>
                    </View>
                  </View>
                  <View style={styles.previewContainer}>
                    <FacefusionPreview style={styles.previewImage} />
                  </View>
                </View>
              )}

              {swapError != null && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{swapError}</Text>
                </View>
              )}

              {swapResult != null && (
                <View style={styles.card}>
                  <View style={styles.resultCardHeader}>
                    <Text style={styles.resultTitle}>Photo Result</Text>
                    <View style={styles.resultSuccessBadge}>
                      <Text style={styles.resultSuccessBadgeText}>Ready</Text>
                    </View>
                  </View>

                  <View style={styles.resultMetaRow}>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        Faces:{' '}
                        <Text style={styles.resultBold}>
                          {swapResult.faceCount}
                        </Text>
                      </Text>
                    </View>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        Tier:{' '}
                        <Text style={styles.resultBold}>{swapResult.tier}</Text>
                      </Text>
                    </View>
                  </View>

                  <View style={styles.pathChip}>
                    <Text
                      style={styles.resultPathText}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {swapResult.outputPath}
                    </Text>
                  </View>

                  <View style={styles.previewContainer}>
                    <Image
                      style={styles.previewImage}
                      source={{ uri: toUri(swapResult.outputPath) }}
                      resizeMode="contain"
                    />
                  </View>

                  {/* Copies outputPath into MediaStore */}
                  <TouchableOpacity
                    style={styles.saveButton}
                    onPress={saveSwapToGallery}
                    disabled={savingPhoto}
                    activeOpacity={0.7}
                  >
                    {savingPhoto ? (
                      <ActivityIndicator size="small" color="#34c759" />
                    ) : (
                      <Text style={styles.saveButtonText}>Save to Gallery</Text>
                    )}
                  </TouchableOpacity>

                  {savedPhotoUri != null && (
                    <View style={styles.savedSuccessBox}>
                      <Text
                        style={styles.savedSuccessText}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        Saved: {savedPhotoUri}
                      </Text>
                    </View>
                  )}
                  {savePhotoError != null && (
                    <Text style={styles.errorText}>{savePhotoError}</Text>
                  )}
                </View>
              )}
            </>
          ) : (
            /* ============= VIDEO SWAP VIEW ============= */
            <>
              <View style={styles.card}>
                <View style={styles.boxHeader}>
                  <View style={styles.boxTitleRow}>
                    <Text style={styles.boxTitle}>Video Swap</Text>
                    <View style={styles.badgeTag}>
                      <Text style={styles.badgeTagText}>VIDEO CLIP</Text>
                    </View>
                  </View>
                  <Text style={styles.hint}>
                    Swap source face into target video frames.
                  </Text>
                </View>

                {/* Side-by-side Dual Media Preview & Selection */}
                <View style={styles.dualMediaRow}>
                  {/* Source Media Column (Step 1) */}
                  <View style={styles.mediaCol}>
                    <View style={styles.stepHeaderRow}>
                      <View style={styles.stepTitleGroup}>
                        <View style={styles.stepBadge}>
                          <Text style={styles.stepBadgeNumber}>1</Text>
                        </View>
                        <Text style={styles.stepTitle}>Source Face</Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.mediaSlot}
                      onPress={pickSource}
                      activeOpacity={0.8}
                    >
                      {sourcePath ? (
                        <>
                          <Image
                            source={{ uri: toUri(sourcePath) }}
                            style={styles.mediaImage}
                            resizeMode="cover"
                          />
                          <View style={styles.changeOverlay}>
                            <Text style={styles.changeOverlayText}>Change</Text>
                          </View>
                        </>
                      ) : (
                        <View style={styles.placeholderBox}>
                          <View style={styles.placeholderIconCircle}>
                            <Text style={styles.placeholderPlus}>+</Text>
                          </View>
                          <Text style={styles.placeholderMain}>
                            Source Face
                          </Text>
                          <Text style={styles.placeholderSub}>
                            Tap to choose
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>

                    {/* Detect Faces Button */}
                    <TouchableOpacity
                      style={styles.compactDetectButton}
                      onPress={detectFaces}
                      disabled={detectingFaces || !isReady || !sourcePath}
                      activeOpacity={0.7}
                    >
                      {detectingFaces ? (
                        <ActivityIndicator size="small" color="#0a84ff" />
                      ) : (
                        <Text style={styles.compactDetectButtonText}>
                          Detect Faces
                        </Text>
                      )}
                    </TouchableOpacity>

                    {detectError != null && (
                      <View style={styles.compactErrorBox}>
                        <Text style={styles.compactErrorText}>
                          {detectError}
                        </Text>
                      </View>
                    )}

                    {sourceFaces.length > 0 && (
                      <View style={styles.facePillWrap}>
                        <TouchableOpacity
                          style={[
                            styles.facePillCompact,
                            selectedFaceIndex === null &&
                              styles.facePillSelected,
                          ]}
                          onPress={() => setSelectedFaceIndex(null)}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.facePillTextCompact,
                              selectedFaceIndex === null &&
                                styles.facePillTextSelected,
                            ]}
                          >
                            Largest
                          </Text>
                        </TouchableOpacity>
                        {sourceFaces.map((face, i) => (
                          <TouchableOpacity
                            key={i}
                            style={[
                              styles.facePillCompact,
                              selectedFaceIndex === i &&
                                styles.facePillSelected,
                            ]}
                            onPress={() => setSelectedFaceIndex(i)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={[
                                styles.facePillTextCompact,
                                selectedFaceIndex === i &&
                                  styles.facePillTextSelected,
                              ]}
                            >
                              F{i + 1} ({(face.score * 100).toFixed(0)}%)
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>

                  {/* Arrow Divider */}
                  <View style={styles.arrowCol}>
                    <View style={styles.arrowBadge}>
                      <Text style={styles.arrowChar}>TO</Text>
                    </View>
                  </View>

                  {/* Target Video Column (Step 2) */}
                  <View style={styles.mediaCol}>
                    <View style={styles.stepHeaderRow}>
                      <View style={styles.stepTitleGroup}>
                        <View style={styles.stepBadge}>
                          <Text style={styles.stepBadgeNumber}>2</Text>
                        </View>
                        <Text style={styles.stepTitle}>Target Video</Text>
                      </View>
                    </View>

                    <TouchableOpacity
                      style={styles.mediaSlot}
                      onPress={pickVideoTarget}
                      activeOpacity={0.8}
                    >
                      {videoTargetPath ? (
                        <View style={styles.videoSlotActive}>
                          <View style={styles.videoTagBadge}>
                            <Text style={styles.videoTagText}>VIDEO</Text>
                          </View>
                          <Text
                            style={styles.videoCompactFileName}
                            numberOfLines={2}
                            ellipsizeMode="middle"
                          >
                            {videoTargetPath.split('/').pop() ||
                              videoTargetPath}
                          </Text>
                          <View style={styles.changeOverlay}>
                            <Text style={styles.changeOverlayText}>Change</Text>
                          </View>
                        </View>
                      ) : (
                        <View style={styles.placeholderBox}>
                          <View style={styles.placeholderIconCircle}>
                            <Text style={styles.placeholderPlus}>+</Text>
                          </View>
                          <Text style={styles.placeholderMain}>
                            Target Video
                          </Text>
                          <Text style={styles.placeholderSub}>
                            Tap to choose
                          </Text>
                        </View>
                      )}
                    </TouchableOpacity>

                    {/* Detect Faces in Video Button */}
                    <TouchableOpacity
                      style={styles.compactDetectButton}
                      onPress={detectTargetFacesForVideo}
                      disabled={
                        detectingVideoTargetFaces ||
                        !isReady ||
                        !videoTargetPath
                      }
                      activeOpacity={0.7}
                    >
                      {detectingVideoTargetFaces ? (
                        <ActivityIndicator size="small" color="#0a84ff" />
                      ) : (
                        <Text style={styles.compactDetectButtonText}>
                          Detect Faces
                        </Text>
                      )}
                    </TouchableOpacity>

                    {detectVideoTargetError != null && (
                      <View style={styles.compactErrorBox}>
                        <Text style={styles.compactErrorText}>
                          {detectVideoTargetError}
                        </Text>
                      </View>
                    )}

                    {videoTargetFaces.length > 0 && (
                      <View style={styles.facePillWrap}>
                        <TouchableOpacity
                          style={[
                            styles.facePillCompact,
                            selectedVideoTargetFaceIndex === null &&
                              styles.facePillSelected,
                          ]}
                          onPress={() => setSelectedVideoTargetFaceIndex(null)}
                          activeOpacity={0.7}
                        >
                          <Text
                            style={[
                              styles.facePillTextCompact,
                              selectedVideoTargetFaceIndex === null &&
                                styles.facePillTextSelected,
                            ]}
                          >
                            All
                          </Text>
                        </TouchableOpacity>
                        {videoTargetFaces.map((face, i) => (
                          <TouchableOpacity
                            key={i}
                            style={[
                              styles.facePillCompact,
                              selectedVideoTargetFaceIndex === i &&
                                styles.facePillSelected,
                            ]}
                            onPress={() => setSelectedVideoTargetFaceIndex(i)}
                            activeOpacity={0.7}
                          >
                            <Text
                              style={[
                                styles.facePillTextCompact,
                                selectedVideoTargetFaceIndex === i &&
                                  styles.facePillTextSelected,
                              ]}
                            >
                              F{i + 1} ({(face.score * 100).toFixed(0)}%)
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}
                  </View>
                </View>

                {/* Compact FPS row */}
                <View style={styles.compactFpsRow}>
                  <View style={styles.compactFpsLeft}>
                    <Text style={styles.compactFpsLabel}>Cap FPS</Text>
                    {fpsCapEnabled && (
                      <View style={styles.fpsStepperInline}>
                        <TouchableOpacity
                          style={styles.fpsMiniBtn}
                          onPress={() =>
                            setTargetFpsValue((v) => Math.max(1, v - 1))
                          }
                          activeOpacity={0.7}
                        >
                          <Text style={styles.fpsMiniBtnText}>-</Text>
                        </TouchableOpacity>
                        <Text style={styles.fpsValueText}>
                          {targetFpsValue} fps
                        </Text>
                        <TouchableOpacity
                          style={styles.fpsMiniBtn}
                          onPress={() =>
                            setTargetFpsValue((v) => Math.min(30, v + 1))
                          }
                          activeOpacity={0.7}
                        >
                          <Text style={styles.fpsMiniBtnText}>+</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                  <Switch
                    value={fpsCapEnabled}
                    onValueChange={(v) => {
                      LayoutAnimation.configureNext(
                        LayoutAnimation.Presets.easeInEaseOut
                      );
                      setFpsCapEnabled(v);
                    }}
                    trackColor={{ false: '#3a3a3c', true: '#34c759' }}
                    thumbColor="#ffffff"
                  />
                </View>

                {/* Collapsible custom path options */}
                <TouchableOpacity
                  style={styles.pathsToggle}
                  onPress={() => setShowPaths((v) => !v)}
                  activeOpacity={0.7}
                >
                  <Text style={styles.pathsToggleText}>
                    {showPaths ? 'Hide file paths' : 'Show file paths'}
                  </Text>
                </TouchableOpacity>

                {showPaths && (
                  <View style={styles.pathsContainer}>
                    <Text style={styles.inputLabel}>Target Video Path</Text>
                    <TextInput
                      style={styles.input}
                      value={videoTargetPath}
                      onChangeText={setVideoTargetPath}
                      placeholder="Target video path"
                      placeholderTextColor="#636366"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={styles.inputLabel}>Output Video Path</Text>
                    <TextInput
                      style={styles.input}
                      value={videoOutputPath}
                      onChangeText={setVideoOutputPath}
                      placeholder="Output video path"
                      placeholderTextColor="#636366"
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                  </View>
                )}

                {/* Step 3: Run Video Swap Button */}
                <TouchableOpacity
                  style={[
                    styles.primaryButton,
                    (videoSwapping || videoBlocker != null) &&
                      styles.buttonDisabled,
                  ]}
                  onPress={swapVid}
                  disabled={videoSwapping || videoBlocker != null}
                  activeOpacity={0.8}
                >
                  {videoSwapping ? (
                    <ActivityIndicator size="small" color="#000000" />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      3 Run Video Swap
                    </Text>
                  )}
                </TouchableOpacity>

                {videoBlocker != null && !videoSwapping && (
                  <View style={styles.blockerCard}>
                    <Text style={styles.blockerText}>{videoBlocker}</Text>
                  </View>
                )}

                {videoSwapping && (
                  <TouchableOpacity
                    style={[styles.secondaryButton, styles.cancelButton]}
                    onPress={cancelVideoSwap}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.cancelButtonText}>Cancel Swap</Text>
                  </TouchableOpacity>
                )}

                {/* Live Preview */}
                {videoSwapping && (
                  <View style={styles.previewContainer}>
                    <FacefusionPreview style={styles.previewImage} />
                  </View>
                )}

                {videoProgress != null && videoSwapping && (
                  <View style={styles.progressBox}>
                    <View style={styles.progressBarTrack}>
                      <View
                        style={[
                          styles.progressBarFill,
                          { width: `${videoPercent}%` },
                        ]}
                      />
                    </View>
                    <View style={styles.progressInfoRow}>
                      <Text style={styles.progressText}>
                        frame {videoProgress.frameIndex}
                        {videoProgress.estimatedFrameCount > 0
                          ? ` / ~${videoProgress.estimatedFrameCount}`
                          : ''}
                      </Text>
                      <Text style={styles.progressFpsText}>
                        {videoProgress.fps.toFixed(1)} fps
                      </Text>
                    </View>
                  </View>
                )}
              </View>

              {videoError != null && (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{videoError}</Text>
                </View>
              )}

              {videoResult != null && (
                <View style={styles.card}>
                  <View style={styles.resultCardHeader}>
                    <Text style={styles.resultTitle}>Video Result</Text>
                    <View style={styles.resultSuccessBadge}>
                      <Text style={styles.resultSuccessBadgeText}>Ready</Text>
                    </View>
                  </View>

                  <View style={styles.resultMetaRow}>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        Frames:{' '}
                        <Text style={styles.resultBold}>
                          {videoResult.frameCount}
                        </Text>
                      </Text>
                    </View>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        Faces:{' '}
                        <Text style={styles.resultBold}>
                          {videoResult.faceFrameCount}
                        </Text>
                      </Text>
                    </View>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        FPS:{' '}
                        <Text style={styles.resultBold}>
                          {videoResult.fps.toFixed(1)}
                        </Text>
                      </Text>
                    </View>
                  </View>

                  <View style={styles.resultMetaRow}>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        Tier:{' '}
                        <Text style={styles.resultBold}>
                          {videoResult.tier}
                        </Text>
                      </Text>
                    </View>
                    <View style={styles.resultChip}>
                      <Text style={styles.resultMetaText}>
                        Audio:{' '}
                        <Text style={styles.resultBold}>
                          {videoResult.hasAudio ? 'yes' : 'none'}
                        </Text>
                      </Text>
                    </View>
                  </View>

                  <View style={styles.pathChip}>
                    <Text
                      style={styles.resultPathText}
                      numberOfLines={1}
                      ellipsizeMode="middle"
                    >
                      {videoResult.outputPath}
                    </Text>
                  </View>

                  <TouchableOpacity
                    style={styles.saveButton}
                    onPress={saveVideoToGallery}
                    disabled={savingVideo}
                    activeOpacity={0.7}
                  >
                    {savingVideo ? (
                      <ActivityIndicator size="small" color="#34c759" />
                    ) : (
                      <Text style={styles.saveButtonText}>Save to Gallery</Text>
                    )}
                  </TouchableOpacity>

                  {savedVideoUri != null && (
                    <View style={styles.savedSuccessBox}>
                      <Text
                        style={styles.savedSuccessText}
                        numberOfLines={1}
                        ellipsizeMode="middle"
                      >
                        Saved: {savedVideoUri}
                      </Text>
                    </View>
                  )}
                  {saveVideoError != null && (
                    <Text style={styles.errorText}>{saveVideoError}</Text>
                  )}
                </View>
              )}
            </>
          )}

          {/* ===== Advanced options. Deliberately LAST: these are expert
                controls (mask blur, detector confidence, pixel boost) and a
                first-time user should reach Source -> Target -> Run before
                ever seeing them. They apply to both the photo and video swap
                above. ===== */}
          {/* Advanced Options Trigger Bar */}
          <TouchableOpacity
            style={styles.advancedOptionsBar}
            onPress={() => setShowOptionsSheet(true)}
            activeOpacity={0.7}
          >
            <View style={styles.advancedOptionsBarLeft}>
              <Text style={styles.advancedOptionsTitle}>Advanced Options</Text>
              <Text style={styles.advancedOptionsSubtitle}>
                Identity blend, mask blur, detector & enhancer
              </Text>
            </View>
            <View style={styles.advancedOptionsAction}>
              <Text style={styles.advancedOptionsActionText}>Configure</Text>
            </View>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* Advanced Options Bottom Sheet Modal */}
      <Modal
        visible={showOptionsSheet}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowOptionsSheet(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setShowOptionsSheet(false)}
          />
          <View style={styles.bottomSheetContainer}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Advanced Options</Text>
              <TouchableOpacity
                onPress={() => setShowOptionsSheet(false)}
                style={styles.sheetDoneButton}
                activeOpacity={0.7}
              >
                <Text style={styles.sheetDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.sheetContent}
              contentContainerStyle={styles.sheetInner}
              showsVerticalScrollIndicator={false}
            >
              <View style={styles.sheetOptionsGroup}>
                <NumberStepper
                  label="Identity blend"
                  value={swapperWeight}
                  onChange={setSwapperWeight}
                  min={0}
                  max={1}
                  step={0.05}
                />
                <View style={styles.optionDivider} />
                <NumberStepper
                  label="Mask blur"
                  value={maskBlur}
                  onChange={setMaskBlur}
                  min={0}
                  max={1}
                  step={0.05}
                />
                <View style={styles.optionDivider} />
                <NumberStepper
                  label="Mask padding"
                  value={maskPadding}
                  onChange={setMaskPadding}
                  min={0}
                  max={100}
                  step={5}
                  format={(v) => `${v}%`}
                />
                <View style={styles.optionDivider} />
                <NumberStepper
                  label="Detector confidence"
                  value={detectorScore}
                  onChange={setDetectorScore}
                  min={0}
                  max={1}
                  step={0.05}
                />
                <View style={styles.optionDivider} />
                <NumberStepper
                  label="Landmarker confidence"
                  value={landmarkerScore}
                  onChange={setLandmarkerScore}
                  min={0}
                  max={1}
                  step={0.05}
                />
                <View style={styles.optionDivider} />
                <NumberStepper
                  label="Pixel boost"
                  value={pixelBoost}
                  onChange={(v) => setPixelBoost(Math.round(v))}
                  min={1}
                  max={4}
                  step={1}
                  format={(v) => `${v}x (${256 * v}px)`}
                />
                <View style={styles.optionDivider} />
                <ToggleRow
                  label="Swap largest face only"
                  value={largestFaceOnly}
                  onChange={setLargestFaceOnly}
                />
                <View style={styles.optionDivider} />
                <ToggleRow
                  label={
                    models?.hasEnhancer
                      ? 'Face enhancer'
                      : 'Face enhancer (not downloaded)'
                  }
                  value={faceEnhance}
                  onChange={toggleFaceEnhance}
                  disabled={!models?.hasEnhancer}
                />
                {faceEnhance && (
                  <>
                    <View style={styles.optionDivider} />
                    <NumberStepper
                      label="Enhancer blend"
                      value={faceEnhancerBlend}
                      onChange={setFaceEnhancerBlend}
                      min={0}
                      max={1}
                      step={0.1}
                    />
                  </>
                )}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Device & Models Bottom Sheet Modal */}
      <Modal
        visible={showDeviceSheet}
        transparent={true}
        animationType="slide"
        onRequestClose={() => setShowDeviceSheet(false)}
      >
        <View style={styles.modalOverlay}>
          <TouchableOpacity
            style={styles.modalBackdrop}
            activeOpacity={1}
            onPress={() => setShowDeviceSheet(false)}
          />
          <View style={styles.bottomSheetContainer}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Device & Models</Text>
              <TouchableOpacity
                onPress={() => setShowDeviceSheet(false)}
                style={styles.sheetDoneButton}
                activeOpacity={0.7}
              >
                <Text style={styles.sheetDoneText}>Done</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.sheetContent}
              contentContainerStyle={styles.sheetInner}
              showsVerticalScrollIndicator={false}
            >
              {/* Device Section */}
              <View style={styles.card}>
                <View style={styles.cardHeaderRow}>
                  <Text style={styles.cardTitle}>Device</Text>
                  {probing && (
                    <ActivityIndicator size="small" color="#8e8e93" />
                  )}
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
                        style={[
                          styles.progressBarFill,
                          { width: `${percent}%` },
                        ]}
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
            </ScrollView>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
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
      <Text style={styles.stepperLabel}>{label}</Text>
      <View style={styles.stepperControls}>
        <TouchableOpacity
          style={styles.stepperButton}
          onPress={() => onChange(clamp(value - step))}
          activeOpacity={0.7}
        >
          <Text style={styles.stepperButtonText}>-</Text>
        </TouchableOpacity>
        <Text style={styles.stepperValue}>
          {format ? format(value) : value.toFixed(2)}
        </Text>
        <TouchableOpacity
          style={styles.stepperButton}
          onPress={() => onChange(clamp(value + step))}
          activeOpacity={0.7}
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
    <View style={styles.stepperRow}>
      <Text style={[styles.stepperLabel, disabled && styles.mutedText]}>
        {label}
      </Text>
      <View style={styles.toggleWrapper}>
        <Switch
          value={value}
          onValueChange={onChange}
          disabled={disabled}
          trackColor={{ false: '#3a3a3c', true: '#34c759' }}
          thumbColor="#ffffff"
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#000000',
    paddingTop:
      Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) + 6 : 0,
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
  topBarRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deviceButton: {
    backgroundColor: '#242426',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#343438',
  },
  deviceButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
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
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2c2c2e',
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
  boxHeader: {
    marginBottom: 12,
  },
  boxTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 4,
  },
  boxTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.2,
  },
  badgeTag: {
    backgroundColor: 'rgba(10, 132, 255, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(10, 132, 255, 0.3)',
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  badgeTagText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#0a84ff',
    letterSpacing: 0.5,
  },
  stepSection: {
    backgroundColor: '#242426',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#323236',
    padding: 12,
    marginBottom: 10,
  },
  stepHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  stepTitleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#0a84ff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepBadgeNumber: {
    fontSize: 11,
    fontWeight: '700',
    color: '#ffffff',
  },
  stepTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  },
  actionPill: {
    backgroundColor: 'rgba(10, 132, 255, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(10, 132, 255, 0.3)',
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  actionPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0a84ff',
  },
  blockerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 159, 10, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255, 159, 10, 0.25)',
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginTop: 8,
  },
  // Why the primary button is disabled, said out loud. Amber, not red: nothing has
  // gone wrong yet, the user just has a step left.
  blockerText: {
    fontSize: 12,
    color: '#ff9f0a',
    textAlign: 'center',
    flex: 1,
  },
  hint: {
    fontSize: 12,
    color: '#8e8e93',
    lineHeight: 16,
  },
  identityNotice: {
    backgroundColor: 'rgba(10, 132, 255, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(10, 132, 255, 0.2)',
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 10,
  },
  identityNoticeText: {
    fontSize: 11,
    color: '#0a84ff',
    fontWeight: '500',
  },
  lockedNotice: {
    backgroundColor: 'rgba(255, 159, 10, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255, 159, 10, 0.2)',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 8,
    marginTop: 8,
  },
  lockedNoticeText: {
    fontSize: 11,
    color: '#ff9f0a',
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
  input: {
    backgroundColor: '#18181a',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#343438',
    paddingHorizontal: 11,
    paddingVertical: 9,
    fontSize: 12,
    color: '#ffffff',
    fontVariant: ['tabular-nums'],
  },
  detectButton: {
    backgroundColor: '#2c2c2e',
    borderWidth: 1,
    borderColor: '#3a3a3c',
    borderRadius: 8,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  detectButtonText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ebebf5',
  },
  primaryButton: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    paddingVertical: 13,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    shadowColor: '#ffffff',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
  secondaryButton: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  buttonDisabled: {
    opacity: 0.35,
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#000000',
    letterSpacing: 0.2,
  },
  secondaryButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#ffffff',
  },
  cancelButton: {
    backgroundColor: 'rgba(255, 69, 58, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(255, 69, 58, 0.35)',
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
    marginTop: 6,
  },
  errorText: {
    fontSize: 12,
    color: '#ff453a',
  },
  previewHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  liveIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#34c759',
  },
  liveText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#34c759',
    letterSpacing: 0.5,
  },
  resultCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  resultTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
  resultSuccessBadge: {
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.35)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  resultSuccessBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#34c759',
  },
  resultMetaRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
    flexWrap: 'wrap',
  },
  resultChip: {
    backgroundColor: '#242426',
    borderWidth: 1,
    borderColor: '#323236',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  resultMetaText: {
    fontSize: 12,
    color: '#8e8e93',
  },
  resultBold: {
    color: '#ffffff',
    fontWeight: '600',
  },
  pathChip: {
    backgroundColor: '#18181a',
    borderRadius: 6,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
  },
  resultPathText: {
    fontSize: 11,
    color: '#8e8e93',
    fontVariant: ['tabular-nums'],
  },
  previewContainer: {
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  previewImage: {
    width: '100%',
    height: 200,
  },
  saveButton: {
    backgroundColor: 'rgba(52, 199, 89, 0.15)',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.35)',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  saveButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#34c759',
  },
  savedSuccessBox: {
    backgroundColor: 'rgba(52, 199, 89, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(52, 199, 89, 0.25)',
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    marginTop: 8,
  },
  savedSuccessText: {
    fontSize: 11,
    color: '#34c759',
    fontVariant: ['tabular-nums'],
  },
  fpsOptionsContainer: {
    marginTop: 6,
    marginBottom: 6,
  },
  progressBox: {
    marginTop: 10,
  },
  progressBarTrack: {
    height: 6,
    backgroundColor: '#2c2c2e',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#0a84ff',
    borderRadius: 3,
  },
  progressInfoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  progressText: {
    fontSize: 11,
    color: '#8e8e93',
    fontVariant: ['tabular-nums'],
  },
  progressFpsText: {
    fontSize: 11,
    color: '#0a84ff',
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 4,
    minHeight: 48,
  },
  stepperLabel: {
    fontSize: 14,
    color: '#ffffff',
    fontWeight: '500',
    flex: 1,
    marginRight: 12,
  },
  stepperControls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  toggleWrapper: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    minWidth: 50,
  },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperButtonText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#ffffff',
    lineHeight: 20,
    textAlign: 'center',
  },
  stepperValue: {
    fontSize: 13,
    color: '#0a84ff',
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    width: 70,
    textAlign: 'center',
  },
  optionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#2c2c2e',
  },
  faceList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 8,
  },
  facePill: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: '#1c1c1e',
    borderWidth: 1,
    borderColor: '#3a3a3c',
  },
  facePillSelected: {
    backgroundColor: '#0a84ff',
    borderColor: '#0a84ff',
  },
  facePillText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#8e8e93',
  },
  facePillTextSelected: {
    color: '#ffffff',
    fontWeight: '700',
  },
  swapModeBar: {
    flexDirection: 'row',
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 3,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  modeTab: {
    flex: 1,
    paddingVertical: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    flexDirection: 'row',
    gap: 6,
  },
  modeTabActive: {
    backgroundColor: '#2c2c2e',
  },
  modeTabText: {
    fontSize: 13,
    fontWeight: '500',
    color: '#8e8e93',
  },
  modeTabTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  runningBadge: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#0a84ff',
  },
  dualMediaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 12,
  },
  mediaCol: {
    flex: 1,
    backgroundColor: '#242426',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#323236',
    padding: 10,
  },
  arrowCol: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 54,
  },
  arrowBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#2c2c2e',
    borderWidth: 1,
    borderColor: '#3a3a3c',
    alignItems: 'center',
    justifyContent: 'center',
  },
  arrowChar: {
    fontSize: 13,
    color: '#0a84ff',
    fontWeight: '700',
  },
  mediaSlot: {
    width: '100%',
    height: 120,
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#18181a',
    borderWidth: 1,
    borderColor: '#343438',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginBottom: 8,
  },
  mediaImage: {
    width: '100%',
    height: '100%',
  },
  changeOverlay: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: 'rgba(0, 0, 0, 0.75)',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
  },
  changeOverlayText: {
    fontSize: 10,
    fontWeight: '600',
    color: '#ffffff',
  },
  placeholderBox: {
    alignItems: 'center',
    justifyContent: 'center',
    padding: 8,
  },
  placeholderIconCircle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#242426',
    borderWidth: 1,
    borderColor: '#3a3a3c',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
  },
  placeholderPlus: {
    fontSize: 20,
    lineHeight: 22,
    color: '#0a84ff',
    fontWeight: '400',
  },
  placeholderMain: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  placeholderSub: {
    fontSize: 10,
    color: '#8e8e93',
    marginTop: 2,
  },
  compactDetectButton: {
    backgroundColor: '#2c2c2e',
    borderWidth: 1,
    borderColor: '#3a3a3c',
    borderRadius: 8,
    paddingVertical: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactDetectButtonText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ebebf5',
  },
  compactErrorBox: {
    backgroundColor: 'rgba(255, 69, 58, 0.12)',
    padding: 6,
    borderRadius: 6,
    marginTop: 6,
  },
  compactErrorText: {
    fontSize: 10,
    color: '#ff453a',
    textAlign: 'center',
  },
  facePillWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 6,
  },
  facePillCompact: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: '#1c1c1e',
    borderWidth: 1,
    borderColor: '#3a3a3c',
  },
  facePillTextCompact: {
    fontSize: 10,
    fontWeight: '600',
    color: '#8e8e93',
  },
  pathsToggle: {
    paddingVertical: 6,
    alignItems: 'center',
    marginBottom: 6,
  },
  pathsToggleText: {
    fontSize: 11,
    color: '#0a84ff',
    fontWeight: '500',
  },
  pathsContainer: {
    backgroundColor: '#18181a',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    padding: 10,
    marginBottom: 10,
  },
  videoSlotActive: {
    width: '100%',
    height: '100%',
    padding: 8,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  videoCompactFileName: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ffffff',
    textAlign: 'center',
    marginTop: 4,
    paddingHorizontal: 4,
  },
  videoTagBadge: {
    backgroundColor: '#242426',
    paddingHorizontal: 6,
    paddingVertical: 3,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#3a3a3c',
  },
  videoTagText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#0a84ff',
    letterSpacing: 0.5,
  },
  compactFpsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#18181a',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#2c2c2e',
  },
  compactFpsLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  compactFpsLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
  fpsStepperInline: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#242426',
    borderRadius: 6,
    paddingHorizontal: 4,
    paddingVertical: 2,
    gap: 6,
  },
  fpsMiniBtn: {
    width: 22,
    height: 22,
    borderRadius: 4,
    backgroundColor: '#2c2c2e',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fpsMiniBtnText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
    lineHeight: 16,
  },
  fpsValueText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#0a84ff',
    fontVariant: ['tabular-nums'],
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.65)',
  },
  modalBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  bottomSheetContainer: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    height: '82%',
    maxHeight: '90%',
    paddingBottom: Platform.OS === 'android' ? 24 : 34,
    borderTopWidth: 1,
    borderColor: '#2c2c2e',
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#3a3a3c',
    alignSelf: 'center',
    marginTop: 8,
    marginBottom: 8,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#2c2c2e',
  },
  sheetTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.2,
  },
  sheetDoneButton: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  sheetDoneText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#0a84ff',
  },
  sheetContent: {
    flex: 1,
    paddingHorizontal: 16,
  },
  sheetInner: {
    paddingVertical: 16,
    gap: 12,
  },
  sheetOptionsGroup: {
    backgroundColor: '#242426',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    overflow: 'hidden',
  },
  advancedOptionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#1c1c1e',
    borderRadius: 14,
    padding: 14,
    borderWidth: 1,
    borderColor: '#2c2c2e',
    marginTop: 2,
  },
  advancedOptionsBarLeft: {
    flex: 1,
    marginRight: 10,
  },
  advancedOptionsTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  advancedOptionsSubtitle: {
    fontSize: 11,
    color: '#8e8e93',
    marginTop: 2,
  },
  advancedOptionsAction: {
    backgroundColor: '#2c2c2e',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#3a3a3c',
  },
  advancedOptionsActionText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0a84ff',
  },
});
