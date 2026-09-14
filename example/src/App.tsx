import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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

export default function App() {
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
  const [outputPath, setOutputPath] = useState(DEFAULT_OUTPUT);
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
  const [optionsExpanded, setOptionsExpanded] = useState(false);
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
      .then((r) => {
        setResultStamp(Date.now());
        setSwapResult(r);
      })
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
      ? 'Choose a source face in the Photo card above.'
      : videoTargetPath.trim() === ''
        ? 'Choose a target clip.'
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
      <ScrollView
        style={styles.content}
        contentContainerStyle={styles.contentInner}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {tab === 'swap' ? (
          /* ================= SWAP VIEW ================= */
          <View style={styles.tabPane}>
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

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Photo</Text>
              <Text style={styles.hint}>
                The face from step 1 replaces the face in step 2.
              </Text>

              <View style={styles.labelRow}>
                <Text style={styles.inputLabel}>
                  <Text style={styles.stepNumber}>1</Text> Source face
                </Text>
                <TouchableOpacity onPress={pickSource}>
                  <Text style={styles.pickLink}>Choose photo…</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={sourcePath}
                onChangeText={setSourcePath}
                placeholder="Tap “Choose photo…” — the face to copy from"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              {/* ===== Source face picker — which face is the identity, when the
                  source photo has more than one. See ADR-0012. ===== */}
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={detectFaces}
                disabled={detectingFaces || !isReady}
              >
                {detectingFaces ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={styles.secondaryButtonText}>
                    Detect Faces in Source
                  </Text>
                )}
              </TouchableOpacity>

              {detectError != null && (
                <Text style={styles.errorText}>{detectError}</Text>
              )}

              {sourceFaces.length > 0 && (
                <View style={styles.faceList}>
                  <TouchableOpacity
                    style={[
                      styles.facePill,
                      selectedFaceIndex === null && styles.facePillSelected,
                    ]}
                    onPress={() => setSelectedFaceIndex(null)}
                  >
                    <Text style={styles.facePillText}>Largest (default)</Text>
                  </TouchableOpacity>
                  {sourceFaces.map((face, i) => (
                    <TouchableOpacity
                      key={i}
                      style={[
                        styles.facePill,
                        selectedFaceIndex === i && styles.facePillSelected,
                      ]}
                      onPress={() => setSelectedFaceIndex(i)}
                    >
                      <Text style={styles.facePillText}>
                        Face {i + 1} — {(face.score * 100).toFixed(0)}%
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <View style={styles.labelRow}>
                <Text style={styles.inputLabel}>
                  <Text style={styles.stepNumber}>2</Text> Target photo
                </Text>
                <TouchableOpacity onPress={pickTarget}>
                  <Text style={styles.pickLink}>Choose photo…</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={targetPath}
                onChangeText={setTargetPath}
                placeholder="Tap “Choose photo…” — the photo to change"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              {/* ===== Target face picker — which face in targetPath actually gets
                  swapped, when it has more than one. See ADR-0014. ===== */}
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={detectTargetFacesForPhoto}
                disabled={detectingTargetFaces || !isReady}
              >
                {detectingTargetFaces ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={styles.secondaryButtonText}>
                    Detect Faces in Target
                  </Text>
                )}
              </TouchableOpacity>

              {detectTargetError != null && (
                <Text style={styles.errorText}>{detectTargetError}</Text>
              )}

              {targetFaces.length > 0 && (
                <View style={styles.faceList}>
                  <TouchableOpacity
                    style={[
                      styles.facePill,
                      selectedTargetFaceIndex === null &&
                        styles.facePillSelected,
                    ]}
                    onPress={() => setSelectedTargetFaceIndex(null)}
                  >
                    <Text style={styles.facePillText}>
                      Every face (default)
                    </Text>
                  </TouchableOpacity>
                  {targetFaces.map((face, i) => (
                    <TouchableOpacity
                      key={i}
                      style={[
                        styles.facePill,
                        selectedTargetFaceIndex === i &&
                          styles.facePillSelected,
                      ]}
                      onPress={() => setSelectedTargetFaceIndex(i)}
                    >
                      <Text style={styles.facePillText}>
                        Face {i + 1} — {(face.score * 100).toFixed(0)}%
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              <Text style={styles.inputLabel}>Output file</Text>
              <TextInput
                style={styles.input}
                value={outputPath}
                onChangeText={setOutputPath}
                placeholder="where to write the result"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

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
                  <Text style={styles.primaryButtonText}>
                    <Text style={styles.stepNumber}>3</Text> Run Swap
                  </Text>
                )}
              </TouchableOpacity>

              {photoBlocker != null && !swapping && (
                <Text style={styles.blockerText}>{photoBlocker}</Text>
              )}
            </View>

            {/* Live Preview -- the swapped frame, drawn natively straight into this view's
                own Surface (PreviewSurfaceHolder.kt) the moment PhotoSwap has it, no pixels
                over the bridge. */}
            {swapping && (
              <View style={styles.card}>
                <Text style={styles.cardTitle}>Live Preview</Text>
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
                <View style={styles.resultMetaRow}>
                  <Text style={styles.resultMetaText}>
                    Faces:{' '}
                    <Text style={styles.resultBold}>
                      {swapResult.faceCount}
                    </Text>
                  </Text>
                  <Text style={styles.resultMetaText}>
                    Tier:{' '}
                    <Text style={styles.resultBold}>{swapResult.tier}</Text>
                  </Text>
                </View>
                <Text
                  style={styles.resultPathText}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {swapResult.outputPath}
                </Text>

                <View style={styles.previewContainer}>
                  <Image
                    style={styles.previewImage}
                    source={{
                      uri: `file://${swapResult.outputPath}?v=${resultStamp}`,
                    }}
                    resizeMode="contain"
                  />
                </View>

                {/* Copies outputPath (this app's own private storage) into MediaStore, so
                    it shows up in the Photos app and survives an uninstall. */}
                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={saveSwapToGallery}
                  disabled={savingPhoto}
                >
                  {savingPhoto ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.secondaryButtonText}>
                      Save to Gallery
                    </Text>
                  )}
                </TouchableOpacity>

                {savedPhotoUri != null && (
                  <Text
                    style={styles.resultPathText}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    Saved: {savedPhotoUri}
                  </Text>
                )}
                {savePhotoError != null && (
                  <Text style={styles.errorText}>{savePhotoError}</Text>
                )}
              </View>
            )}

            {/* ============= VIDEO SWAP ============= */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Video</Text>
              <Text style={styles.hint}>
                The same source face from step 1, swapped into every frame of a
                clip. Keeps running if you leave the app, and a long clip takes
                a while — roughly 10 frames a second at 720p.
              </Text>

              <View style={styles.labelRow}>
                <Text style={styles.inputLabel}>Target clip</Text>
                <TouchableOpacity onPress={pickVideoTarget}>
                  <Text style={styles.pickLink}>Choose video…</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={videoTargetPath}
                onChangeText={setVideoTargetPath}
                placeholder="Tap “Choose video…” — the clip to change"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              {/* ===== Target face picker (video) — same idea as the photo one above,
                  detected from the clip's first frame. See ADR-0014. ===== */}
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={detectTargetFacesForVideo}
                disabled={detectingVideoTargetFaces || !isReady}
              >
                {detectingVideoTargetFaces ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Text style={styles.secondaryButtonText}>
                    Detect Faces in Target
                  </Text>
                )}
              </TouchableOpacity>

              {detectVideoTargetError != null && (
                <Text style={styles.errorText}>{detectVideoTargetError}</Text>
              )}

              {videoTargetFaces.length > 0 && (
                <View style={styles.faceList}>
                  <TouchableOpacity
                    style={[
                      styles.facePill,
                      selectedVideoTargetFaceIndex === null &&
                        styles.facePillSelected,
                    ]}
                    onPress={() => setSelectedVideoTargetFaceIndex(null)}
                  >
                    <Text style={styles.facePillText}>
                      Every face (default)
                    </Text>
                  </TouchableOpacity>
                  {videoTargetFaces.map((face, i) => (
                    <TouchableOpacity
                      key={i}
                      style={[
                        styles.facePill,
                        selectedVideoTargetFaceIndex === i &&
                          styles.facePillSelected,
                      ]}
                      onPress={() => setSelectedVideoTargetFaceIndex(i)}
                    >
                      <Text style={styles.facePillText}>
                        Face {i + 1} — {(face.score * 100).toFixed(0)}%
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              {/* A locked box, not tracked frame to frame -- if the subject moves far out
                  of it, that face silently stops being swapped. See ADR-0014. */}
              {selectedVideoTargetFaceIndex !== null && (
                <Text style={styles.hint}>
                  Locked to this face's position in the first frame — not
                  re-detected per frame, so a subject who moves far out of it
                  stops being swapped.
                </Text>
              )}

              <Text style={styles.inputLabel}>Output Path</Text>
              <TextInput
                style={styles.input}
                value={videoOutputPath}
                onChangeText={setVideoOutputPath}
                placeholder="output video path"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              {/* ===== FPS cap — set before running the swap. Drops frames before they
                  ever reach the NPU or encoder, not after. See ADR-0014. ===== */}
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
                  <Text style={styles.primaryButtonText}>Run Video Swap</Text>
                )}
              </TouchableOpacity>

              {videoBlocker != null && !videoSwapping && (
                <Text style={styles.blockerText}>{videoBlocker}</Text>
              )}

              {videoSwapping && (
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.cancelButton]}
                  onPress={cancelVideoSwap}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
              )}

              {/* Live Preview -- one frame at a time, straight from VideoSwap.kt's own
                  decode/swap loop, drawn natively into this view's Surface. Same component
                  as the photo card above; PreviewSurfaceHolder.kt doesn't know or care which
                  swap is feeding it. */}
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
                  <Text style={styles.progressText}>
                    frame {videoProgress.frameIndex}
                    {videoProgress.estimatedFrameCount > 0
                      ? ` / ~${videoProgress.estimatedFrameCount}`
                      : ''}{' '}
                    · {videoProgress.fps.toFixed(1)} fps
                  </Text>
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
                <View style={styles.resultMetaRow}>
                  <Text style={styles.resultMetaText}>
                    Frames:{' '}
                    <Text style={styles.resultBold}>
                      {videoResult.frameCount}
                    </Text>
                  </Text>
                  <Text style={styles.resultMetaText}>
                    Faces in:{' '}
                    <Text style={styles.resultBold}>
                      {videoResult.faceFrameCount}
                    </Text>
                  </Text>
                  <Text style={styles.resultMetaText}>
                    fps:{' '}
                    <Text style={styles.resultBold}>
                      {videoResult.fps.toFixed(1)}
                    </Text>
                  </Text>
                </View>
                <Text style={styles.resultMetaText}>
                  Tier:{' '}
                  <Text style={styles.resultBold}>{videoResult.tier}</Text> ·
                  Audio:{' '}
                  <Text style={styles.resultBold}>
                    {videoResult.hasAudio ? 'yes' : 'none'}
                  </Text>
                </Text>
                <Text
                  style={styles.resultPathText}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {videoResult.outputPath}
                </Text>

                <TouchableOpacity
                  style={styles.secondaryButton}
                  onPress={saveVideoToGallery}
                  disabled={savingVideo}
                >
                  {savingVideo ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.secondaryButtonText}>
                      Save to Gallery
                    </Text>
                  )}
                </TouchableOpacity>

                {savedVideoUri != null && (
                  <Text
                    style={styles.resultPathText}
                    numberOfLines={1}
                    ellipsizeMode="middle"
                  >
                    Saved: {savedVideoUri}
                  </Text>
                )}
                {saveVideoError != null && (
                  <Text style={styles.errorText}>{saveVideoError}</Text>
                )}
              </View>
            )}
            {/* ===== Advanced options. Deliberately LAST: these are expert
                controls (mask blur, detector confidence, pixel boost) and a
                first-time user should reach Source -> Target -> Run before
                ever seeing them. They apply to both the photo and video swap
                above. ===== */}
            <View style={styles.card}>
              <TouchableOpacity
                style={styles.labelRow}
                onPress={() => setOptionsExpanded((v) => !v)}
                activeOpacity={0.7}
              >
                <Text style={styles.cardTitle}>Advanced Options</Text>
                <Text style={styles.pickLink}>
                  {optionsExpanded ? 'Hide ▲' : 'Show ▼'}
                </Text>
              </TouchableOpacity>

              {optionsExpanded && (
                <View style={styles.optionsBody}>
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
                </View>
              )}
            </View>
          </View>
        ) : (
          /* ================= DEVICE & MODELS VIEW ================= */
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
        )}
      </ScrollView>
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
    borderRadius: 8,
    paddingVertical: 11,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
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
  faceList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    marginBottom: 8,
  },
  facePill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 16,
    backgroundColor: '#2c2c2e',
  },
  facePillSelected: {
    backgroundColor: '#0a84ff',
  },
  facePillText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#ffffff',
  },
});
