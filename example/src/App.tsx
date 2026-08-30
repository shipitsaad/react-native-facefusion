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
  type DeviceProbeResult,
  type ModelStatus,
  type ModelDownloadProgress,
  type SwapOptions,
  type SwapPhotoResult,
  type SwapVideoResult,
  type VideoSwapProgress,
} from 'react-native-facefusion';

// App-specific external storage (getExternalFilesDir) — avoids scoped storage restrictions
// Push photos via: `adb push face.jpg /sdcard/Android/data/facefusion.example/files/source.jpg`
const DEFAULT_SOURCE =
  '/sdcard/Android/data/facefusion.example/files/source.jpg';
const DEFAULT_TARGET =
  '/sdcard/Android/data/facefusion.example/files/target.jpg';
const DEFAULT_OUTPUT =
  '/sdcard/Android/data/facefusion.example/files/swapped.jpg';
// Same directory, a clip instead of a photo — push via:
// `adb push clip.mp4 /sdcard/Android/data/facefusion.example/files/target.mp4`
const DEFAULT_VIDEO_TARGET =
  '/sdcard/Android/data/facefusion.example/files/target.mp4';
const DEFAULT_VIDEO_OUTPUT =
  '/sdcard/Android/data/facefusion.example/files/swapped.mp4';

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

  // Video swap state
  const [videoTargetPath, setVideoTargetPath] = useState(DEFAULT_VIDEO_TARGET);
  const [videoOutputPath, setVideoOutputPath] = useState(DEFAULT_VIDEO_OUTPUT);
  const [videoSwapping, setVideoSwapping] = useState(false);
  const [videoProgress, setVideoProgress] = useState<VideoSwapProgress | null>(
    null
  );
  const [videoResult, setVideoResult] = useState<SwapVideoResult | null>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

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

  const swapOptions: SwapOptions = useMemo(
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
    ]
  );

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
    setSwapping(true);
    swapPhoto(sourcePath, targetPath, outputPath, swapOptions)
      .then(setSwapResult)
      .catch((e: Error) => setSwapError(e.message))
      .finally(() => setSwapping(false));
  }, [sourcePath, targetPath, outputPath, swapOptions]);

  const swapVid = useCallback(() => {
    setVideoError(null);
    setVideoResult(null);
    setVideoProgress(null);
    setVideoSwapping(true);
    swapVideo(sourcePath, videoTargetPath, videoOutputPath, swapOptions)
      .then(setVideoResult)
      .catch((e: Error) => setVideoError(e.message))
      .finally(() => setVideoSwapping(false));
  }, [sourcePath, videoTargetPath, videoOutputPath, swapOptions]);

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

            {/* ============= ADVANCED OPTIONS (shared by photo + video below) ============= */}
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
                  <Text style={styles.hint}>
                    Picking which face to use when the source photo has more
                    than one isn't supported yet — the largest face in the
                    source is always used as the identity.
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.card}>
              <Text style={styles.hint}>
                Push photos via adb:{'\n'}
                adb push face.jpg
                /sdcard/Android/data/facefusion.example/files/source.jpg
              </Text>

              <View style={styles.labelRow}>
                <Text style={styles.inputLabel}>Source Path</Text>
                <TouchableOpacity onPress={pickSource}>
                  <Text style={styles.pickLink}>Pick…</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={sourcePath}
                onChangeText={setSourcePath}
                placeholder="source path"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <View style={styles.labelRow}>
                <Text style={styles.inputLabel}>Target Path</Text>
                <TouchableOpacity onPress={pickTarget}>
                  <Text style={styles.pickLink}>Pick…</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={targetPath}
                onChangeText={setTargetPath}
                placeholder="target path"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Text style={styles.inputLabel}>Output Path</Text>
              <TextInput
                style={styles.input}
                value={outputPath}
                onChangeText={setOutputPath}
                placeholder="output path"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (swapping || !isReady) && styles.buttonDisabled,
                ]}
                onPress={swap}
                disabled={swapping || !isReady}
                activeOpacity={0.8}
              >
                {swapping ? (
                  <ActivityIndicator size="small" color="#000000" />
                ) : (
                  <Text style={styles.primaryButtonText}>Run Swap</Text>
                )}
              </TouchableOpacity>
            </View>

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
                    source={{ uri: `file://${swapResult.outputPath}` }}
                    resizeMode="contain"
                  />
                </View>
              </View>
            )}

            {/* ============= VIDEO SWAP ============= */}
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Video (Phase 7)</Text>
              <Text style={styles.hint}>
                Same source face above, swapped into every frame of a clip. Runs
                behind a foreground service — expect it to take a while.{'\n'}
                adb push clip.mp4
                /sdcard/Android/data/facefusion.example/files/target.mp4
              </Text>

              <View style={styles.labelRow}>
                <Text style={styles.inputLabel}>Target Video Path</Text>
                <TouchableOpacity onPress={pickVideoTarget}>
                  <Text style={styles.pickLink}>Pick…</Text>
                </TouchableOpacity>
              </View>
              <TextInput
                style={styles.input}
                value={videoTargetPath}
                onChangeText={setVideoTargetPath}
                placeholder="target video path"
                placeholderTextColor="#636366"
                autoCapitalize="none"
                autoCorrect={false}
              />

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

              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (videoSwapping || !isReady) && styles.buttonDisabled,
                ]}
                onPress={swapVid}
                disabled={videoSwapping || !isReady}
                activeOpacity={0.8}
              >
                {videoSwapping ? (
                  <ActivityIndicator size="small" color="#000000" />
                ) : (
                  <Text style={styles.primaryButtonText}>Run Video Swap</Text>
                )}
              </TouchableOpacity>

              {videoSwapping && (
                <TouchableOpacity
                  style={[styles.secondaryButton, styles.cancelButton]}
                  onPress={cancelVideoSwap}
                >
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
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
              </View>
            )}
          </View>
        ) : (
          /* ================= DEVICE & MODELS VIEW ================= */
          <View style={styles.tabPane}>
            {/* Device Section */}
            <View style={styles.card}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.cardTitle}>Device Probe</Text>
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
});
