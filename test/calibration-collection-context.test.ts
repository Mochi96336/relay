import assert from 'node:assert/strict';
import test from 'node:test';

import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

const RATE = 48_000;
const DURATION_MS = 20;
const REQUIRED = Math.round((RATE * DURATION_MS) / 1000);

function analysis(micLagMs: number): TimingCalibrationAnalysis {
  return {
    micLagMs,
    confidence: 0.9,
    segmentLagsMs: [micLagMs],
    segmentCorrelations: [0.9],
    micLevelDbfs: -20,
    backingLevelDbfs: -12,
  };
}

function makeHarness() {
  let context: CalibrationContext = {
    sessionGeneration: 1,
    micGeneration: 10,
    backingGeneration: 20,
    micSourceRate: RATE,
    backingSourceRate: RATE,
    sourceGeneration: 0,
  };
  let analyses = 0;
  const calibration = new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 5_000,
    context: () => context,
    analyze: () => {
      analyses += 1;
      return analysis(120);
    },
  });
  return {
    calibration,
    analyses: () => analyses,
    replaceContext(next: CalibrationContext) { context = next; },
    currentContext: () => context,
  };
}

const samples = (count: number) => new Int16Array(count);

test('content calibration fails before accepting PCM from a replacement capture', () => {
  const harness = makeHarness();
  harness.calibration.start(0);
  harness.calibration.observeMic(samples(REQUIRED / 2), 0);
  harness.calibration.observeBacking(samples(REQUIRED / 2), 0);

  harness.replaceContext({
    ...harness.currentContext(),
    micGeneration: 11,
  });
  harness.calibration.observeMic(samples(REQUIRED / 2), REQUIRED / 2);

  const status = harness.calibration.status();
  assert.equal(status.state, 'failed');
  assert.match(status.error ?? '', /capture arrangement changed while calibration was being collected/i);
  assert.equal(status.micSpanSamples, 0);
  assert.equal(status.backingSpanSamples, 0);
  assert.equal(harness.analyses(), 0, 'mixed-capture evidence must never reach the analyser');
});

test('capture change during a retry preserves the previously confirmed calibration', () => {
  const harness = makeHarness();
  harness.calibration.start(0);
  harness.calibration.observeMic(samples(REQUIRED), 0);
  harness.calibration.observeBacking(samples(REQUIRED), 0);
  assert.equal(harness.calibration.confirmedResult?.micLagMs, 120);

  harness.calibration.start(100);
  harness.calibration.observeMic(samples(REQUIRED / 2), REQUIRED);
  harness.calibration.observeBacking(samples(REQUIRED / 2), REQUIRED);
  harness.replaceContext({
    ...harness.currentContext(),
    micGeneration: 11,
  });
  harness.calibration.observeBacking(samples(REQUIRED / 2), REQUIRED + REQUIRED / 2);

  assert.equal(harness.calibration.status().state, 'failed');
  assert.equal(harness.calibration.result?.micLagMs, 120);
  assert.equal(harness.calibration.confirmedResult?.micLagMs, 120);
  assert.equal(harness.calibration.confirmedRevision, 1);
});

test('explicit working-evidence restart rebinds collection to the new context', () => {
  const harness = makeHarness();
  harness.calibration.start(0);
  harness.calibration.observeMic(samples(REQUIRED / 2), 0);
  harness.calibration.observeBacking(samples(REQUIRED / 2), 0);

  harness.replaceContext({
    ...harness.currentContext(),
    sourceGeneration: 1,
  });
  harness.calibration.restartWorkingEvidence(100);
  harness.calibration.observeMic(samples(REQUIRED), REQUIRED);
  harness.calibration.observeBacking(samples(REQUIRED), REQUIRED);

  assert.equal(harness.calibration.status().state, 'complete');
  assert.equal(harness.calibration.confirmedResult?.micLagMs, 120);
  assert.equal(harness.analyses(), 1);
});
