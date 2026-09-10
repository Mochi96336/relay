export type BootProbeAnalysisEvidenceInput = {
  gapSamples: number;
  frontierMissingSamples: number;
  sampleRate: number;
  maxGapMs: number;
};

export type BootProbeAnalysisEvidenceDecision =
  | { kind: 'usable'; gapMs: number }
  | {
      kind: 'reject';
      reason: 'frontier-missing' | 'gap';
      gapMs: number;
      frontierMissingSamples: number;
    };

function nonNegativeFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative and finite.`);
  return value;
}

function positiveFinite(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive and finite.`);
  return value;
}

/**
 * Evidence-density gate for a Boot Probe window whose capture frontier has
 * already reached the requested end.
 *
 * AudioSession preserves positioned packet loss as holes and readRange renders
 * those holes as zeroes. A reached frontier therefore proves span, not usable
 * PCM. This policy keeps transport incompleteness out of the correlator and
 * uses the same maximum-gap semantics as content calibration.
 */
export function decideBootProbeAnalysisEvidence(
  input: BootProbeAnalysisEvidenceInput,
): BootProbeAnalysisEvidenceDecision {
  const gapSamples = nonNegativeFinite(input.gapSamples, 'gapSamples');
  const frontierMissingSamples = nonNegativeFinite(
    input.frontierMissingSamples,
    'frontierMissingSamples',
  );
  const sampleRate = positiveFinite(input.sampleRate, 'sampleRate');
  const maxGapMs = nonNegativeFinite(input.maxGapMs, 'maxGapMs');
  const gapMs = (gapSamples / sampleRate) * 1_000;

  if (frontierMissingSamples > 0) {
    return { kind: 'reject', reason: 'frontier-missing', gapMs, frontierMissingSamples };
  }
  if (gapMs > maxGapMs) {
    return { kind: 'reject', reason: 'gap', gapMs, frontierMissingSamples };
  }
  return { kind: 'usable', gapMs };
}
