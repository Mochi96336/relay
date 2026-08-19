import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { CalibrationSession } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

const RATE = 48_000;
const DURATION_MS = 6_000;
const WINDOW = RATE * 6;
const context = () => ({
  sessionGeneration: 1,
  micGeneration: 10,
  backingGeneration: 20,
  sourceGeneration: 0,
});

function analysis(micLagMs: number, confidence = 0.8): TimingCalibrationAnalysis {
  return {
    micLagMs,
    confidence,
    segmentLagsMs: [micLagMs, micLagMs, micLagMs],
    segmentCorrelations: [0.9, 0.9, 0.9],
    micLevelDbfs: -20,
    backingLevelDbfs: -12,
  };
}

function feedWindow(calibration: CalibrationSession, index: number) {
  const start = index * WINDOW;
  calibration.observeBacking(new Int16Array(WINDOW), start);
  calibration.observeMic(new Int16Array(WINDOW), start);
}

describe('confirmed calibration authority', () => {
  test('confirmedResult survives a fresh retry even while phase is collecting', () => {
    let next = analysis(250);
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      analyze: () => next,
      agreementWindows: 1,
    });

    calibration.start(0);
    feedWindow(calibration, 0);
    assert.equal(calibration.confirmedResult?.micLagMs, 250);

    next = analysis(900, 0.95);
    calibration.start(1);
    assert.equal(calibration.status().state, 'collecting');
    assert.equal(calibration.confirmedResult?.micLagMs, 250, 'phase alone must not revoke old confirmed authority');
  });

  test('a failed retry keeps an old confirmed answer confirmed', () => {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      analyze: () => analysis(250),
      agreementWindows: 1,
    });

    calibration.start(0);
    feedWindow(calibration, 0);
    calibration.start(1);
    calibration.fail('retry interrupted');

    assert.equal(calibration.status().state, 'failed');
    assert.equal(calibration.confirmedResult?.micLagMs, 250);
  });

  test('a surviving provisional guess is never exposed as a confirmed baseline', () => {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      analyze: () => analysis(315, 0.8),
      agreementWindows: 3,
      agreementToleranceMs: 25,
      provisionalConfidence: 0.55,
      now: () => 0,
    });

    calibration.start(0);
    feedWindow(calibration, 0);
    assert.equal(calibration.result?.micLagMs, 315, 'provisional result may be applied');
    assert.equal(calibration.status().provisional, true);
    assert.equal(calibration.confirmedResult, null);

    calibration.fail('later agreement window failed');
    assert.equal(calibration.result?.micLagMs, 315, 'failed retry preserves the applied provisional guess');
    assert.equal(calibration.confirmedResult, null, 'but it must remain eligible for automatic retry');
  });

  test('applyValidatedResult creates a fresh confirmed content result', () => {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
    });

    calibration.applyValidatedResult(analysis(365, 0.77));

    assert.equal(calibration.status().state, 'complete');
    assert.equal(calibration.status().provisional, false);
    assert.equal(calibration.confirmedResult?.micLagMs, 365);
    assert.equal(calibration.confirmedResult?.confidence, 0.77);
  });
});
