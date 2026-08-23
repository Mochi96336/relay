import assert from 'node:assert/strict';
import test from 'node:test';

import { CalibrationSession } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

const RATE = 48_000;
const DURATION_MS = 6_000;
const REQUIRED = RATE * 6;

function analysis(): TimingCalibrationAnalysis {
  return {
    micLagMs: 240,
    confidence: 0.8,
    segmentLagsMs: [240, 240, 240],
    segmentCorrelations: [0.9, 0.9, 0.9],
    micLevelDbfs: -20,
    backingLevelDbfs: -12,
  };
}

function makeSession(
  analyze: () => TimingCalibrationAnalysis | PromiseLike<TimingCalibrationAnalysis> = analysis,
) {
  return new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 20_000,
    context: () => ({
      sessionGeneration: 1,
      micGeneration: 10,
      backingGeneration: 20,
      sourceGeneration: 0,
    }),
    analyze,
  });
}

test('status reports independent bounded mic and backing collection spans', () => {
  const calibration = makeSession();
  calibration.start(0);
  calibration.observeMic(new Int16Array(REQUIRED / 2), 0);
  calibration.observeBacking(new Int16Array(REQUIRED * 2), 0);

  const status = calibration.status();
  assert.equal(status.state, 'collecting');
  assert.equal(status.micSpanSamples, REQUIRED / 2);
  assert.equal(status.backingSpanSamples, REQUIRED, 'projection is bounded to one calibration window');
  assert.ok(Math.abs(status.progress - 0.5) < 0.01, 'shared ready progress still follows the slower side');
});

test('status keeps a fully collected window visible while analysis is pending', () => {
  let resolve!: (value: TimingCalibrationAnalysis) => void;
  const pending = new Promise<TimingCalibrationAnalysis>((resolvePromise) => {
    resolve = resolvePromise;
  });
  const calibration = makeSession(() => pending);
  calibration.start(0);
  calibration.observeMic(new Int16Array(REQUIRED), 0);
  calibration.observeBacking(new Int16Array(REQUIRED), 0);

  const status = calibration.status();
  assert.equal(status.state, 'collecting');
  assert.equal(status.progress, 1);
  assert.equal(status.micSpanSamples, REQUIRED);
  assert.equal(status.backingSpanSamples, REQUIRED);

  calibration.reset();
  resolve(analysis());
});
