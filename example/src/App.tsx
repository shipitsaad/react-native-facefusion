import { useCallback, useEffect, useState } from 'react';
import { Button, Image, Text, TextInput, View, StyleSheet } from 'react-native';
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

// No picker UI yet -- that is Phase 9. Push two test photos with a detectable face to
// these paths (e.g. `adb push face.jpg /sdcard/Download/source.jpg`) and edit here, or
// just retype the paths in the fields below before pressing Swap.
const DEFAULT_SOURCE = '/sdcard/Download/source.jpg';
const DEFAULT_TARGET = '/sdcard/Download/target.jpg';
const DEFAULT_OUTPUT = '/sdcard/Download/swapped.jpg';

export default function App() {
  const [probe, setProbe] = useState<DeviceProbeResult | null>(null);
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

  useEffect(() => {
    probeDevice().then(setProbe).catch(fail(setError));
    getModelStatus().then(setModels).catch(fail(setError));
  }, []);

  useEffect(() => {
    const sub = onModelDownloadProgress(setProgress);
    return () => sub.remove();
  }, []);

  const download = useCallback(() => {
    setError(null);
    setBusy(true);
    downloadModels()
      .then(setModels)
      .catch(fail(setError))
      .finally(() => setBusy(false));
  }, []);

  const swap = useCallback(() => {
    setSwapError(null);
    setSwapResult(null);
    setSwapping(true);
    swapPhoto(sourcePath, targetPath, outputPath)
      .then(setSwapResult)
      .catch(fail(setSwapError))
      .finally(() => setSwapping(false));
  }, [sourcePath, targetPath, outputPath]);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Device probe</Text>
      {probe == null && <Text>probing…</Text>}
      {probe != null && (
        <>
          <Row label="tier" value={probe.tier} />
          <Row label="chain" value={probe.tierChain.join(' → ')} />
          <Row label="measured" value={probe.ok ? 'yes' : 'no'} />
          <Row label="arch" value={probe.ok ? `v${probe.arch}` : '—'} />
          <Row label="vtcm" value={probe.ok ? `${probe.vtcmMb} MB` : '—'} />
          <Row label="soc" value={probe.ok ? String(probe.socModel) : '—'} />
          {probe.error !== '' && (
            <Text style={styles.error}>{probe.error}</Text>
          )}
        </>
      )}

      <Text style={styles.title}>Models</Text>
      {models == null && <Text>checking…</Text>}
      {models != null && (
        <>
          <Row label="tier" value={models.tier} />
          <Row label="ready" value={models.ready ? 'yes' : 'no'} />
          <Row
            label="missing"
            value={models.ready ? '—' : models.missing.join(', ')}
          />
          <Row label="enhancer" value={models.hasEnhancer ? 'yes' : 'no'} />
          <Row
            label="network"
            value={models.metered ? 'metered' : 'unmetered'}
          />
        </>
      )}

      {progress != null && busy && (
        <>
          <Row
            label="file"
            value={`${progress.fileIndex}/${progress.fileCount} ${progress.name}`}
          />
          <Row
            label="progress"
            value={`${mb(progress.doneBytes)} / ${mb(progress.totalBytes)} MB · ${percent(progress)}%`}
          />
        </>
      )}

      {error != null && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        {models != null && !models.ready && !busy && (
          <Button
            title={
              models.metered
                ? 'Download (~317 MB, metered!)'
                : 'Download models'
            }
            onPress={download}
          />
        )}
        {busy && <Button title="Cancel" onPress={cancelModelDownload} />}
      </View>

      <Text style={styles.title}>Swap a photo</Text>
      <Text style={styles.hint}>
        No picker yet (Phase 9) — push two photos to the device and edit the
        paths below, e.g. `adb push face.jpg /sdcard/Download/source.jpg`.
      </Text>
      <TextInput
        style={styles.input}
        value={sourcePath}
        onChangeText={setSourcePath}
        placeholder="source path"
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        value={targetPath}
        onChangeText={setTargetPath}
        placeholder="target path"
        autoCapitalize="none"
      />
      <TextInput
        style={styles.input}
        value={outputPath}
        onChangeText={setOutputPath}
        placeholder="output path"
        autoCapitalize="none"
      />
      <View style={styles.actions}>
        <Button
          title={swapping ? 'Swapping…' : 'Swap'}
          onPress={swap}
          disabled={swapping || models == null || !models.ready}
        />
      </View>
      {swapError != null && <Text style={styles.error}>{swapError}</Text>}
      {swapResult != null && (
        <>
          <Row label="faces" value={String(swapResult.faceCount)} />
          <Row label="tier" value={swapResult.tier} />
          <Row label="output" value={swapResult.outputPath} />
          <Image
            style={styles.preview}
            source={{ uri: `file://${swapResult.outputPath}` }}
          />
        </>
      )}
    </View>
  );
}

const fail = (set: (m: string) => void) => (e: Error) => set(e.message);

const mb = (bytes: number) => (bytes / 1e6).toFixed(1);

const percent = (p: ModelDownloadProgress) =>
  p.totalBytes > 0 ? Math.floor((p.doneBytes / p.totalBytes) * 100) : 0;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 18,
    fontWeight: '600',
    marginTop: 24,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    paddingVertical: 2,
  },
  label: {
    width: 90,
    color: '#666',
  },
  value: {
    flexShrink: 1,
    fontVariant: ['tabular-nums'],
  },
  actions: {
    marginTop: 20,
  },
  error: {
    marginTop: 12,
    color: '#b00',
    textAlign: 'center',
  },
  hint: {
    fontSize: 12,
    color: '#888',
    textAlign: 'center',
    marginBottom: 8,
  },
  input: {
    width: '100%',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#ccc',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
    fontSize: 13,
  },
  preview: {
    width: 240,
    height: 240,
    marginTop: 12,
    resizeMode: 'contain',
  },
});
