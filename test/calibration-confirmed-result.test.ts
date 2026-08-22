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
    assert.equal(calibration.result?.micLagMs, 250, 'the old confirmed value remains the applied authority during retry');
    assert.equal(calibration.confirmedResult?.micLagMs, 250, 'phase alone must not revoke old confirmed authority');
    assert.equal(calibration.transactionActive, true);
  });

  test('confirmedResult remains one immutable snapshot while retry diagnostics change', () => {
    const scripted = [analysis(250, 0.81), analysis(250, 0.81), analysis(370, 0.96)];
    let index = 0;
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      analyze: () => scripted[Math.min(index++, scripted.length - 1)],
      agreementWindows: 2,
      agreementToleranceMs: 25,
      now: () => 0,
    });

    calibration.start(0);
    feedWindow(calibration, 0);
    feedWindow(calibration, 1);
    assert.deepEqual(calibration.confirmedResult, {
      micLagMs: 250,
      confidence: 0.81,
      segmentLagsMs: [250, 250, 250],
    });

    calibration.start(1);
    feedWindow(calibration, 2);
    assert.equal(calibration.status().state, 'collecting');
    assert.equal(calibration.status().confidence, 0.96, 'working diagnostics may describe the retry');
    assert.equal(calibration.result?.micLagMs, 250, 'working diagnostics cannot replace applied confirmed authority');
    assert.deepEqual(
      calibration.confirmedResult,
      { micLagMs: 250, confidence: 0.81, segmentLagsMs: [250, 250, 250] },
      'old lag must never be combined with new candidate metadata',
    );

    const detached = calibration.confirmedResult!;
    detached.segmentLagsMs[0] = 999;
    assert.equal(calibration.confirmedResult!.segmentLagsMs[0], 250, 'callers cannot mutate authority history');
  });

  test('a failed retry keeps an old confirmed answer applied', () => {
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
    assert.equal(calibration.result?.micLagMs, 250, 'failure rolls back to the previous applied authority');
    assert.equal(calibration.confirmedResult?.micLagMs, 250);
    assert.equal(calibration.status().provisional, false);
    assert.equal(calibration.transactionActive, false);
  });

  test('a failed run revokes its applied provisional guess', () => {
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
    assert.equal(calibration.result?.micLagMs, 315, 'provisional result may be applied while agreement continues');
    assert.equal(calibration.status().provisional, true);
    assert.equal(calibration.confirmedResult, null);

    calibration.fail('later agreement window failed');
    assert.equal(calibration.status().state, 'failed');
    assert.equal(calibration.result, null, 'failed provisional authority must be revoked');
    assert.equal(calibration.status().micLagMs, null);
    assert.equal(calibration.status().provisional, false);
    assert.equal(calibration.confirmedResult, null);
    assert.equal(calibration.transactionActive, false);
  });

  test('analyzer failure after provisional application revokes the provisional', () => {
    let calls = 0;
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      analyze: () => {
        calls += 1;
        if (calls === 1) return analysis(315, 0.8);
        throw new Error('agreement analyzer failed');
      },
      agreementWindows: 2,
      agreementToleranceMs: 25,
      provisionalConfidence: 0.55,
      now: () => 0,
    });

    calibration.start(0);
    feedWindow(calibration, 0);
    assert.equal(calibration.result?.micLagMs, 315);
    assert.equal(calibration.status().provisional, true);

    feedWindow(calibration, 1);
    assert.equal(calibration.status().state, 'failed');
    assert.match(calibration.status().error ?? '', /agreement analyzer failed/);
    assert.equal(calibration.result, null);
    assert.equal(calibration.status().provisional, false);
    assert.equal(calibration.transactionActive, false);
  });

  test('a successful retry promotes confirmed and applied authority atomically', () => {
    const scripted = [analysis(250, 0.81), analysis(250, 0.81), analysis(370, 0.96), analysis(372, 0.96)];
    let index = 0;
    let calibration!: CalibrationSession;
    const settled: Array<{
      applied: number | null;
      confirmed: number | null;
      revision: number;
      transactionActive: boolean;
    }> = [];

    calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      analyze: () => scripted[Math.min(index++, scripted.length - 1)],
      agreementWindows: 2,
      agreementToleranceMs: 25,
      now: () => 0,
      onSettled: () => {
        settled.push({
          applied: calibration.result?.micLagMs ?? null,
          confirmed: calibration.confirmedResult?.micLagMs ?? null,
          revision: calibration.confirmedRevision,
          transactionActive: calibration.transactionActive,
        });
      },
    });

    calibration.start(0);
    feedWindow(calibration, 0);
    feedWindow(calibration, 1);
    assert.equal(calibration.confirmedRevision, 1);
    assert.equal(calibration.result?.micLagMs, 250);

    calibration.start(1);
    feedWindow(calibration, 2);
    assert.equal(calibration.result?.micLagMs, 250, 'candidate does not replace old confirmed authority');
    assert.equal(calibration.confirmedResult?.micLagMs, 250);

    feedWindow(calibration, 3);
    assert.equal(calibration.confirmedRevision, 2);
    assert.equal(calibration.result?.micLagMs, 372);
    assert.equal(calibration.confirmedResult?.micLagMs, 372);
    assert.deepEqual(settled.at(-1), {
      applied: 372,
      confirmed: 372,
      revision: 2,
      transactionActive: false,
    }, 'onSettled observes one fully promoted authority, never a half-commit');
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

  test('robot external recalibration failure preserves the previous confirmed authority', () => {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
    });

    calibration.applyExternalResult({ micLagMs: 420, confidence: 0.9 });
    calibration.beginExternalRecalibration();

    assert.equal(calibration.transactionActive, true);
    assert.equal(calibration.result?.micLagMs, 420, 'known-good Robot alignment stays applied during the new probe');
    assert.equal(calibration.confirmedResult?.micLagMs, 420);

    calibration.fail('Robot calibration probe failed.');

    assert.equal(calibration.status().state, 'failed');
    assert.equal(calibration.transactionActive, false);
    assert.equal(calibration.result?.micLagMs, 420, 'failed Robot probe rolls back to old authority');
    assert.equal(calibration.confirmedResult?.micLagMs, 420);
  });

  test('robot external results keep the existing settled callback contract', () => {
    let settled = 0;
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context,
      onSettled: () => { settled += 1; },
    });

    calibration.applyExternalResult({ micLagMs: 420, confidence: 0.9 });

    assert.equal(settled, 1);
    assert.deepEqual(calibration.confirmedResult, {
      micLagMs: 420,
      confidence: 0.9,
      segmentLagsMs: [],
    });
  });
});
