import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CalibrationSession,
  DEFAULT_CALIBRATION_ANALYSIS_TIMEOUT_MS,
  type CalibrationContext,
} from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

const RATE = 1_000;
const DURATION_MS = 10;
const REQUIRED = 10;
const CONTEXT: CalibrationContext = {
  sessionGeneration: 1,
  micGeneration: 10,
  backingGeneration: 20,
  sourceGeneration: 0,
};

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

function fill(calibration: CalibrationSession) {
  calibration.observeMic(new Int16Array(REQUIRED), 0);
  calibration.observeBacking(new Int16Array(REQUIRED), 0);
}

test('async analysis has its own bounded phase deadline and fences a late result', async () => {
  const pending = deferred<TimingCalibrationAnalysis>();
  let nowMs = 100;
  let workerSignal: AbortSignal | undefined;
  const calibration = new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 10_000,
    analysisTimeoutMs: 500,
    context: () => CONTEXT,
    analyze: (_mic, _backing, _rate, _maxLagMs, signal) => {
      workerSignal = signal;
      return pending.promise;
    },
    now: () => nowMs,
  });

  calibration.start(0);
  fill(calibration);
  assert.equal(calibration.status().state, 'collecting');
  assert.equal(calibration.status().progress, 1);
  assert.equal(workerSignal?.aborted, false);

  nowMs = 599;
  assert.equal(calibration.tick(999_999), false,
    'capture-clock input cannot consume the independent analysis budget');
  assert.equal(workerSignal?.aborted, false);

  nowMs = 600;
  assert.equal(calibration.tick(999_999), true, 'analysis expires exactly at its own deadline');
  assert.equal(workerSignal?.aborted, true, 'timing out aborts work that can no longer update state');
  assert.equal(calibration.status().state, 'failed');
  assert.match(calibration.status().error ?? '', /analysis timed out after 500 ms/);
  assert.equal(calibration.result, null);

  pending.resolve(analysis(999));
  await nextTurn();
  assert.equal(calibration.status().state, 'failed', 'late analysis cannot revive the expired attempt');
  assert.equal(calibration.result, null);
});

test('analysis timeout keeps the previous confirmed calibration serving', async () => {
  const pending = deferred<TimingCalibrationAnalysis>();
  let nowMs = 0;
  let calls = 0;
  let retrySignal: AbortSignal | undefined;
  const calibration = new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 10_000,
    analysisTimeoutMs: 500,
    context: () => CONTEXT,
    analyze: (_mic, _backing, _rate, _maxLagMs, signal) => {
      calls += 1;
      if (calls === 1) return analysis(240);
      retrySignal = signal;
      return pending.promise;
    },
    now: () => nowMs,
  });

  calibration.start(0);
  fill(calibration);
  assert.equal(calibration.status().state, 'complete');
  assert.equal(calibration.result?.micLagMs, 240);
  assert.equal(calibration.confirmedResult?.micLagMs, 240);

  nowMs = 1_000;
  calibration.start(1_000);
  fill(calibration);
  assert.equal(calibration.status().state, 'collecting');
  assert.equal(retrySignal?.aborted, false);

  nowMs = 1_500;
  assert.equal(calibration.tick(50_000), true);
  assert.equal(retrySignal?.aborted, true);
  assert.equal(calibration.status().state, 'failed');
  assert.equal(calibration.result?.micLagMs, 240,
    'a failed retry must not discard the last confirmed authority');
  assert.equal(calibration.confirmedResult?.micLagMs, 240);

  pending.resolve(analysis(999));
  await nextTurn();
  assert.equal(calibration.result?.micLagMs, 240, 'late retry output remains fenced');
  assert.equal(calibration.confirmedResult?.micLagMs, 240);
});

test('analysis deadline defaults to a finite bound and rejects invalid configuration', () => {
  assert.equal(DEFAULT_CALIBRATION_ANALYSIS_TIMEOUT_MS, 20_000);
  assert.throws(
    () => new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 10_000,
      analysisTimeoutMs: 0,
      context: () => CONTEXT,
    }),
    /analysisTimeoutMs must be positive/,
  );
});
