import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';
import { laggedPair } from './helpers/harness.js';

const RATE = 48_000;
const DURATION_MS = 6_000;
const REQUIRED = Math.round((RATE * DURATION_MS) / 1000);

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

type Harness = {
  calibration: CalibrationSession;
  settled: number;
  context: CalibrationContext;
};

function makeSession(options: {
  analyze?: (mic: Int16Array, backing: Int16Array, rate: number) => TimingCalibrationAnalysis;
  timeoutMs?: number;
} = {}) {
  const harness: Harness = {
    settled: 0,
    context: { sessionGeneration: 1, micGeneration: 10 },
    calibration: undefined as unknown as CalibrationSession,
  };

  harness.calibration = new CalibrationSession({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: options.timeoutMs ?? 20_000,
    context: () => harness.context,
    analyze: options.analyze ?? (() => analysis(240)),
    onSettled: () => { harness.settled += 1; },
  });

  return harness;
}

const chunk = (samples: number) => new Int16Array(samples);

function fill(calibration: CalibrationSession, micSamples: number, backingSamples: number) {
  if (micSamples > 0) calibration.observeMic(chunk(micSamples));
  if (backingSamples > 0) calibration.observeBacking(chunk(backingSamples));
}

describe('CalibrationSession lifecycle', () => {
  test('starts idle and reports no measurement', () => {
    const { calibration } = makeSession();
    const status = calibration.status();

    assert.equal(status.state, 'idle');
    assert.equal(status.micLagMs, null);
    assert.equal(status.progress, 0);
    assert.equal(calibration.result, null);
  });

  test('ignores samples until collection is started', () => {
    const { calibration } = makeSession();
    fill(calibration, REQUIRED, REQUIRED);

    assert.equal(calibration.status().state, 'idle');
    assert.equal(calibration.result, null);
  });

  test('reports progress from whichever side is behind', () => {
    const { calibration } = makeSession();
    calibration.start(0);

    fill(calibration, REQUIRED / 2, REQUIRED);
    assert.ok(Math.abs(calibration.status().progress - 0.5) < 0.01);
  });

  test('completes only once both sides are full', () => {
    const harness = makeSession();
    harness.calibration.start(0);

    fill(harness.calibration, REQUIRED, 0);
    assert.equal(harness.calibration.status().state, 'collecting', 'one full side is not enough');

    fill(harness.calibration, 0, REQUIRED);
    assert.equal(harness.calibration.status().state, 'complete');
    assert.equal(harness.calibration.result?.micLagMs, 240);
    assert.equal(harness.settled, 1);
  });

  test('stops accepting samples once a side is full', () => {
    const { calibration } = makeSession({
      analyze: (mic, backing) => {
        assert.equal(mic.length, REQUIRED, 'the analyser must get exactly the requested length');
        assert.equal(backing.length, REQUIRED);
        return analysis(100);
      },
    });

    calibration.start(0);
    fill(calibration, REQUIRED * 2, REQUIRED * 2);
    assert.equal(calibration.status().state, 'complete');
  });

  test('surfaces an analyser rejection as a failure, not a crash', () => {
    const harness = makeSession({
      analyze: () => { throw new Error('Calibration signal is weak (corr 0.03).'); },
    });

    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    const status = harness.calibration.status();
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /signal is weak/);
    assert.equal(harness.calibration.result, null);
    assert.equal(harness.settled, 1);
  });

  test('a rejected attempt does not discard the previous good answer', () => {
    let lag = 240;
    const { calibration } = makeSession({ analyze: () => analysis(lag) });

    calibration.start(0);
    fill(calibration, REQUIRED, REQUIRED);
    assert.equal(calibration.result?.micLagMs, 240);

    lag = 999;
    calibration.start(0);
    calibration.fail('Play YouTube on the phone before calibration.');

    assert.equal(calibration.status().state, 'failed');
    assert.equal(calibration.result?.micLagMs, 240, 'the applied measurement must survive a failed retry');
  });

  test('failing clears the partial capture so a retry starts clean', () => {
    const { calibration } = makeSession();
    calibration.start(0);
    fill(calibration, REQUIRED / 2, REQUIRED / 2);

    calibration.fail('Microphone disconnected during calibration.');
    calibration.start(0);
    assert.equal(calibration.status().progress, 0);

    fill(calibration, REQUIRED / 2, REQUIRED / 2);
    assert.ok(Math.abs(calibration.status().progress - 0.5) < 0.01, 'no leftovers from the abandoned run');
  });

  test('reset drops the measurement entirely', () => {
    const { calibration } = makeSession();
    calibration.start(0);
    fill(calibration, REQUIRED, REQUIRED);

    calibration.reset();
    assert.equal(calibration.result, null);
    assert.equal(calibration.status().state, 'idle');
    assert.equal(calibration.status().micLagMs, null);
  });
});

describe('CalibrationSession timeout', () => {
  test('gives up when a side stops streaming', () => {
    const harness = makeSession({ timeoutMs: 1_000 });
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED / 4, REQUIRED);

    assert.equal(harness.calibration.tick(500), false, 'still within the budget');
    assert.equal(harness.calibration.tick(1_500), true);

    const status = harness.calibration.status();
    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /timed out \(mic 1500 ms, source 6000 ms of 6000 ms\)/);
    assert.equal(harness.settled, 1, 'the timeout must announce itself');
  });

  test('does nothing when no collection is running', () => {
    const { calibration } = makeSession({ timeoutMs: 1_000 });
    assert.equal(calibration.tick(999_999), false);
    assert.equal(calibration.status().state, 'idle');
  });
});

describe('CalibrationSession staleness', () => {
  test('holds for the setup it was measured against', () => {
    const harness = makeSession();
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(harness.calibration.isStaleFor(1, 10), false);
  });

  test('is stale once the microphone starts a new capture', () => {
    const harness = makeSession();
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(harness.calibration.isStaleFor(1, 11), true);
  });

  test('is stale in a different live session', () => {
    const harness = makeSession();
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(harness.calibration.isStaleFor(2, 10), true);
  });

  test('records the capture that produced the samples, not the one at start', () => {
    const harness = makeSession();
    harness.calibration.start(0);

    // The phone restarts its capture midway; the answer describes what finished.
    harness.context = { sessionGeneration: 1, micGeneration: 12 };
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(harness.calibration.isStaleFor(1, 12), false);
    assert.equal(harness.calibration.isStaleFor(1, 10), true);
  });

  test('nothing measured is never stale', () => {
    const { calibration } = makeSession();
    assert.equal(calibration.isStaleFor(99, 99), false);
  });
});

describe('CalibrationSession with the real analyser', () => {
  test('recovers an injected lag end to end', () => {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context: () => ({ sessionGeneration: 1, micGeneration: 1 }),
    });
    const { mic, backing } = laggedPair(6, RATE, 320);

    calibration.start(0);
    calibration.observeBacking(new Int16Array(backing.buffer, backing.byteOffset, REQUIRED));
    calibration.observeMic(new Int16Array(mic.buffer, mic.byteOffset, REQUIRED));

    const status = calibration.status();
    assert.equal(status.state, 'complete', status.error ?? '');
    assert.ok(Math.abs((status.micLagMs ?? 0) - 320) <= 15, `got ${status.micLagMs} ms`);
  });
});
