import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
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
  type DeviceProbeResult,
  type ModelStatus,
  type ModelDownloadProgress,
  type SwapPhotoResult,
} from 'react-native-facefusion';

// The app's own external files dir -- no storage permission needed to read it, unlike
// /sdcard/Download. Scoped storage (targetSdk 29+) hides other apps' files in shared
// folders from an app with no READ_MEDIA_IMAGES/READ_EXTERNAL_STORAGE permission, so a
// file pushed to Download is invisible here even though `adb shell ls` sees it fine --
// it decodes as "Could not decode image", which reads exactly like a bad path but isn't
// one. `adb push`/`adb shell cp` test photos to this directory instead, the same one
// ModelPaths already uses for the downloaded models.
const APP_FILES_DIR = '/sdcard/Android/data/facefusion.example/files';
const DEFAULT_SOURCE = `${APP_FILES_DIR}/source.jpg`;
const DEFAULT_TARGET = `${APP_FILES_DIR}/target.jpg`;
const DEFAULT_OUTPUT = `${APP_FILES_DIR}/swapped.jpg`;

export default function App() {
  const [probe, setProbe] = useState<DeviceProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [models, setModels] = useState<ModelStatus | null>(null);
  const [progress, setProgress] = useState<ModelDownloadProgress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sourcePath, setSourcePath] = useState(DEFAULT_SOURCE);
  const [targetPath, setTargetPath] = useState(DEFAULT_TARGET);
  const [outputPath, setOutputPath] = useState(DEFAULT_OUTPUT);
  const [swapping, setSwapping] = useState(false);
  const [swapResult, setSwapResult] = useState<SwapPhotoResult | null>(null);
  const [swapError, setSwapError] = useState<string | null>(null);

  const runProbe = useCallback(() => {
    setProbing(true);
    probeDevice()
      .then(setProbe)
      .catch((e: Error) => setError(e.message))
      .finally(() => setProbing(false));
  }, []);

  const refreshModels = useCallback(() => {
    getModelStatus()
      .then(setModels)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    runProbe();
    refreshModels();
  }, [runProbe, refreshModels]);

  useEffect(() => {
    const sub = onModelDownloadProgress(setProgress);
    return () => sub.remove();
  }, []);

  const download = useCallback(() => {
    setError(null);
    setBusy(true);
    downloadModels()
      .then(setModels)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  const swap = useCallback(() => {
    setSwapError(null);
    setSwapResult(null);
    setSwapping(true);
    swapPhoto(sourcePath, targetPath, outputPath)
      .then(setSwapResult)
      .catch((e: Error) => setSwapError(e.message))
      .finally(() => setSwapping(false));
  }, [sourcePath, targetPath, outputPath]);

  const percent =
    progress && progress.totalBytes > 0
      ? Math.min(100, Math.floor((progress.doneBytes / progress.totalBytes) * 100))
      : 0;

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />
      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>FaceFusion</Text>
          <Text style={styles.subtitle}>Hexagon NPU Runtime</Text>
        </View>

        {/* Section: Device Probe */}
        <View style={styles.section}>
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionTitle}>DEVICE PROBE</Text>
            {probing && <ActivityIndicator size="small" color="#8e8e93" />}
          </View>
          <View style={styles.card}>
            {probe == null ? (
              <Text style={styles.placeholderText}>Probing device…</Text>
            ) : (
              <>
                <Row label="Tier" value={probe.tier} />
                <Separator />
                <Row label="Chain" value={probe.tierChain.join(' → ')} />
                <Separator />
                <Row label="Measured" value={probe.ok ? 'Yes' : 'No'} />
                <Separator />
                <Row label="Architecture" value={probe.ok ? `v${probe.arch}` : '—'} />
                <Separator />
                <Row label="VTCM" value={probe.ok ? `${probe.vtcmMb} MB` : '—'} />
                <Separator />
                <Row label="SoC Model" value={probe.ok ? String(probe.socModel) : '—'} />
                {probe.error ? (
                  <>
                    <Separator />
                    <Text style={styles.errorText}>{probe.error}</Text>
                  </>
                ) : null}
              </>
            )}
          </View>
        </View>

        {/* Section: Models */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>MODELS</Text>
          <View style={styles.card}>
            {models == null ? (
              <Text style={styles.placeholderText}>Checking models…</Text>
            ) : (
              <>
                <Row label="Status" value={models.ready ? 'Ready' : 'Incomplete'} highlight={models.ready} />
                <Separator />
                <Row label="Tier" value={models.tier} />
                <Separator />
                <Row
                  label="Missing"
                  value={models.ready ? 'None' : models.missing.join(', ')}
                />
                <Separator />
                <Row label="Enhancer" value={models.hasEnhancer ? 'Installed' : 'None'} />
                <Separator />
                <Row label="Network" value={models.metered ? 'Metered' : 'Unmetered'} />
              </>
            )}

            {/* Download Progress */}
            {progress != null && busy && (
              <View style={styles.progressBox}>
                <View style={styles.progressBarTrack}>
                  <View style={[styles.progressBarFill, { width: `${percent}%` }]} />
                </View>
                <Text style={styles.progressText}>
                  {progress.name ? `${progress.name} · ` : ''}
                  {(progress.doneBytes / 1e6).toFixed(1)} / {(progress.totalBytes / 1e6).toFixed(1)} MB ({percent}%)
                </Text>
              </View>
            )}

            {error != null && <Text style={styles.errorText}>{error}</Text>}

            {/* Download Actions */}
            {models != null && !models.ready && !busy && (
              <TouchableOpacity style={styles.button} onPress={download}>
                <Text style={styles.buttonText}>
                  {models.metered ? 'Download Models (~317 MB, Metered)' : 'Download Models (~317 MB)'}
                </Text>
              </TouchableOpacity>
            )}

            {busy && (
              <TouchableOpacity style={[styles.button, styles.cancelButton]} onPress={cancelModelDownload}>
                <Text style={styles.cancelButtonText}>Cancel Download</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Section: Swap Photo */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>SWAP PHOTO</Text>
          <View style={styles.card}>
            <Text style={styles.inputLabel}>Source Path</Text>
            <TextInput
              style={styles.input}
              value={sourcePath}
              onChangeText={setSourcePath}
              placeholder="/path/to/source.jpg"
              placeholderTextColor="#636366"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Target Path</Text>
            <TextInput
              style={styles.input}
              value={targetPath}
              onChangeText={setTargetPath}
              placeholder="/path/to/target.jpg"
              placeholderTextColor="#636366"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <Text style={styles.inputLabel}>Output Path</Text>
            <TextInput
              style={styles.input}
              value={outputPath}
              onChangeText={setOutputPath}
              placeholder="/path/to/output.jpg"
              placeholderTextColor="#636366"
              autoCapitalize="none"
              autoCorrect={false}
            />

            <TouchableOpacity
              style={[
                styles.button,
                styles.primaryButton,
                (swapping || models == null || !models.ready) && styles.buttonDisabled,
              ]}
              onPress={swap}
              disabled={swapping || models == null || !models.ready}
            >
              {swapping ? (
                <ActivityIndicator size="small" color="#000000" />
              ) : (
                <Text style={styles.primaryButtonText}>Run Swap</Text>
              )}
            </TouchableOpacity>

            {swapError != null && <Text style={styles.errorText}>{swapError}</Text>}
          </View>
        </View>

        {/* Section: Result */}
        {swapResult != null && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>RESULT</Text>
            <View style={styles.card}>
              <Row label="Faces" value={String(swapResult.faceCount)} />
              <Separator />
              <Row label="Tier" value={swapResult.tier} />
              <Separator />
              <Row label="Output" value={swapResult.outputPath} />

              <View style={styles.previewContainer}>
                <Image
                  style={styles.previewImage}
                  source={{ uri: `file://${swapResult.outputPath}` }}
                  resizeMode="contain"
                />
              </View>
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
      <Text style={[styles.value, highlight && styles.valueHighlight]}>{value}</Text>
    </View>
  );
}

function Separator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#000000',
  },
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 40,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 14,
    color: '#8e8e93',
    marginTop: 2,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginLeft: 4,
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8e8e93',
    letterSpacing: 0.5,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: '#1c1c1e',
    borderRadius: 12,
    padding: 16,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  label: {
    fontSize: 14,
    color: '#8e8e93',
  },
  value: {
    fontSize: 14,
    color: '#ffffff',
    fontWeight: '500',
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: 16,
  },
  valueHighlight: {
    color: '#34c759',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: '#2c2c2e',
    marginVertical: 4,
  },
  placeholderText: {
    fontSize: 14,
    color: '#636366',
    paddingVertical: 4,
  },
  inputLabel: {
    fontSize: 12,
    color: '#8e8e93',
    marginBottom: 6,
    marginTop: 6,
  },
  input: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: '#ffffff',
    marginBottom: 10,
    fontVariant: ['tabular-nums'],
  },
  button: {
    backgroundColor: '#2c2c2e',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  primaryButton: {
    backgroundColor: '#ffffff',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  primaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#000000',
  },
  cancelButton: {
    backgroundColor: '#3a1c1c',
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ff453a',
  },
  progressBox: {
    marginTop: 12,
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
    fontSize: 12,
    color: '#8e8e93',
    marginTop: 6,
    fontVariant: ['tabular-nums'],
  },
  errorText: {
    fontSize: 13,
    color: '#ff453a',
    marginTop: 8,
  },
  previewContainer: {
    marginTop: 14,
    borderRadius: 8,
    overflow: 'hidden',
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: {
    width: '100%',
    height: 240,
  },
});
