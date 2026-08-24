import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

const RATE = 48_000;
const DURATION_MS = 6_000;
const REQUIRED = Math.round((RATE * DURATION_MS) / 1000);
const chunk = (samples: number) => new Int16Array(samples);

function analysis(micLagMs: number): TimingCalibrationAnalysis {
  return {
    micLagMs,
    confidence: 0.8,
    segmentLagsMs: [micLagMs, micLagMs, micLagMs],
    segmentCorrelations: [0.9, 0.9, 0.9],
    micLevelDbfs: -20,
    backingLevelDbfs: -12,
  };
}

function makeSession() {
  let lag = 240;
  let context: CalibrationContext = {
    sessionGeneration: 1,
    micGeneration: 10,
    backingGeneration: 20,
    sourceGeneration: 0,
  };
  const calibration = new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 20_000,
    context: () => context,
    analyze: () => analysis(lag),
  });

  return {
    calibration,
    setLag(next: number) { lag = next; },
    setContext(next: CalibrationContext) { context = next; },
    get context() { return context; },
  };
}

function fill(calibration: CalibrationSession, samples: number, startSample: number) {
  calibration.observeMic(chunk(samples), startSample);
  calibration.observeBacking(chunk(samples), startSample);
}

function prime(calibration: CalibrationSession, samples: number, startSample: number) {
  calibration.primeMic(chunk(samples), startSample);
  calibration.primeBacking(chunk(samples), startSample);
}

describe('CalibrationSession primed fallback', () => {
  test('preferred-probe failure keeps old confirmed authority while primed evidence survives to promotion', () => {
    const harness = makeSession();
    const primedSamples = REQUIRED - RATE;

    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, 0);
    assert.equal(harness.calibration.result?.micLagMs, 240);
    const confirmedRevision = harness.calibration.confirmedRevision;

    harness.calibration.beginExternalRecalibration();
    prime(harness.calibration, primedSamples, 0);
    harness.setLag(420);
    harness.calibration.failPreservingPrimed('Robot probe exhausted.');

    assert.equal(harness.calibration.status().state, 'failed');
    assert.equal(
      harness.calibration.result?.micLagMs,
      240,
      'failed preferred work must not revoke the previous confirmed authority',
    );
    assert.equal(harness.calibration.confirmedRevision, confirmedRevision);

    harness.calibration.startFromPrimed(100);
    assert.equal(harness.calibration.status().state, 'collecting');
    assert.ok(Math.abs(harness.calibration.status().progress - primedSamples / REQUIRED) < 0.01);
    assert.equal(
      harness.calibration.result?.micLagMs,
      240,
      'primed PCM remains evidence, not replacement authority, while collection is open',
    );

    fill(harness.calibration, RATE, primedSamples);
    assert.equal(harness.calibration.status().state, 'complete');
    assert.equal(harness.calibration.result?.micLagMs, 420);
    assert.equal(harness.calibration.confirmedRevision, confirmedRevision + 1);
  });

  test('discardPrimedContent makes a destructive source change start from zero backup evidence', () => {
    const harness = makeSession();
    const primedSamples = REQUIRED - RATE;
    prime(harness.calibration, primedSamples, 0);

    assert.equal(harness.calibration.status().state, 'idle');
    assert.equal(harness.calibration.result, null, 'priming alone must never create authority');

    harness.calibration.discardPrimedContent();
    harness.calibration.startFromPrimed(100);

    assert.equal(harness.calibration.status().state, 'collecting');
    assert.equal(harness.calibration.status().progress, 0);
    fill(harness.calibration, RATE, 0);
    assert.equal(harness.calibration.result, null, 'discarded backup cannot complete from one fresh second');
    assert.ok(Math.abs(harness.calibration.status().progress - 1 / 6) < 0.01);
  });

  test('handoff refuses primed evidence whose source context changed before fallback', () => {
    const harness = makeSession();
    prime(harness.calibration, REQUIRED - RATE, 0);

    harness.setContext({ ...harness.context, sourceGeneration: harness.context.sourceGeneration + 1 });
    harness.calibration.startFromPrimed(100);

    assert.equal(harness.calibration.status().state, 'collecting');
    assert.equal(
      harness.calibration.status().progress,
      0,
      'a stale source generation must not be relabelled as evidence for the current source',
    );
  });

  test('new capture priming replaces old-generation PCM instead of combining generations', () => {
    const harness = makeSession();
    prime(harness.calibration, RATE * 4, 0);

    harness.setContext({ ...harness.context, micGeneration: 11 });
    prime(harness.calibration, RATE, 0);
    harness.calibration.startFromPrimed(100);

    assert.equal(harness.calibration.status().state, 'collecting');
    assert.ok(
      Math.abs(harness.calibration.status().progress - 1 / 6) < 0.01,
      'old-generation backup must be dropped before fresh capture evidence is retained',
    );

    fill(harness.calibration, REQUIRED - RATE, RATE);
    assert.equal(harness.calibration.status().state, 'complete');
  });

  test('mapping discontinuity restarts only working evidence, not the calibration transaction', () => {
    const harness = makeSession();

    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, 0);
    assert.equal(harness.calibration.result?.micLagMs, 240);
    const confirmedRevision = harness.calibration.confirmedRevision;

    harness.setLag(420);
    harness.calibration.start(100);
    fill(harness.calibration, RATE * 4, RATE * 10);
    assert.equal(harness.calibration.status().state, 'collecting');
    assert.ok(Math.abs(harness.calibration.status().progress - 4 / 6) < 0.01);
    assert.equal(harness.calibration.transactionActive, true);
    assert.equal(harness.calibration.result?.micLagMs, 240);

    harness.calibration.restartWorkingEvidence(200);
    assert.equal(harness.calibration.status().state, 'collecting');
    assert.equal(harness.calibration.status().progress, 0);
    assert.equal(harness.calibration.transactionActive, true);
    assert.equal(harness.calibration.result?.micLagMs, 240);
    assert.equal(harness.calibration.confirmedRevision, confirmedRevision);

    fill(harness.calibration, REQUIRED, RATE * 20);
    assert.equal(harness.calibration.status().state, 'complete');
    assert.equal(harness.calibration.result?.micLagMs, 420);
    assert.equal(harness.calibration.confirmedRevision, confirmedRevision + 1);
  });

});
