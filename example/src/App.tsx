import { useEffect, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { probeDevice, type DeviceProbeResult } from 'react-native-facefusion';

export default function App() {
  const [probe, setProbe] = useState<DeviceProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    probeDevice()
      .then(setProbe)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Device probe</Text>
      {error != null && <Text style={styles.error}>{error}</Text>}
      {probe == null && error == null && <Text>probing…</Text>}
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
    </View>
  );
}

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
    marginBottom: 16,
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
    fontVariant: ['tabular-nums'],
  },
  error: {
    marginTop: 12,
    color: '#b00',
    textAlign: 'center',
  },
});
