import assert from 'node:assert/strict';
import test from 'node:test';

import { decideBootProbeAnalysisEvidence } from '../src/boot-probe-analysis-evidence-policy.js';

const base = {
  gapSamples: 0,
  frontierMissingSamples: 0,
  sampleRate: 48_000,
  maxGapMs: 300,
};

test('Boot Probe evidence admits a complete window and the exact shared gap bound', () => {
  assert.deepEqual(decideBootProbeAnalysisEvidence(base), { kind: 'usable', gapMs: 0 });
  const atBound = decideBootProbeAnalysisEvidence({
    ...base,
    gapSamples: 14_400,
  });
  assert.equal(atBound.kind, 'usable', 'the calibration contract rejects only gaps above 300 ms');
  assert.equal(atBound.gapMs, 300);
});

test('Boot Probe evidence rejects a window whose internal capture gap exceeds the shared bound', () => {
  const decision = decideBootProbeAnalysisEvidence({
    ...base,
    gapSamples: 14_401,
  });
  assert.equal(decision.kind, 'reject');
  if (decision.kind !== 'reject') return;
  assert.equal(decision.reason, 'gap');
  assert.ok(decision.gapMs > 300);
  assert.equal(decision.frontierMissingSamples, 0);
});

test('Boot Probe evidence rejects frontier-missing PCM before any correlation', () => {
  const decision = decideBootProbeAnalysisEvidence({
    ...base,
    frontierMissingSamples: 1,
  });
  assert.deepEqual(decision, {
    kind: 'reject',
    reason: 'frontier-missing',
    gapMs: 0,
    frontierMissingSamples: 1,
  });
});

test('Boot Probe evidence rejects invalid accounting inputs instead of silently admitting them', () => {
  assert.throws(
    () => decideBootProbeAnalysisEvidence({ ...base, gapSamples: -1 }),
    /gapSamples must be non-negative and finite/,
  );
  assert.throws(
    () => decideBootProbeAnalysisEvidence({ ...base, sampleRate: 0 }),
    /sampleRate must be positive and finite/,
  );
});
