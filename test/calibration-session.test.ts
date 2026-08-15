import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { CalibrationSession, type CalibrationContext } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';
import { laggedPair, pulseTrain, toInt16 } from './helpers/harness.js';

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
    context: { sessionGeneration: 1, micGeneration: 10, backingGeneration: 20, sourceGeneration: 0 },
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

/**
 * Streams both sides from session sample 0, contiguously. Tests that care about
 * placement state their own indices instead.
 */
function fill(calibration: CalibrationSession, micSamples: number, backingSamples: number) {
  if (micSamples > 0) calibration.observeMic(chunk(micSamples), 0);
  if (backingSamples > 0) calibration.observeBacking(chunk(backingSamples), 0);
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

describe('CalibrationSession placement', () => {
  const filled = (samples: number, value: number) => new Int16Array(samples).fill(value);
  const MS = RATE / 1000;

  /** Runs a collection and hands back what the analyser actually received. */
  function collect(stream: (calibration: CalibrationSession) => void) {
    type Seen = { mic: Int16Array; backing: Int16Array };
    let seen: Seen | null = null;
    const harness = makeSession({
      analyze: (mic, backing) => {
        seen = { mic, backing };
        return analysis(0);
      },
    });

    harness.calibration.start(0);
    stream(harness.calibration);
    return { seen: seen as Seen | null, status: harness.calibration.status() };
  }

  test('a dropped frame leaves silence instead of pulling later audio earlier', () => {
    const half = REQUIRED / 2;
    const gap = 100 * MS;

    const { seen, status } = collect((calibration) => {
      calibration.observeBacking(filled(REQUIRED, 500), 0);
      calibration.observeMic(filled(half, 1_000), 0);
      // The frames covering the next 100 ms never arrived.
      calibration.observeMic(filled(half, 2_000), half + gap);
    });

    assert.equal(status.state, 'complete', status.error ?? '');
    assert.equal(seen!.mic[half - 1], 1_000);
    assert.equal(seen!.mic[half], 0, 'the outage reads as the silence it was');
    assert.equal(seen!.mic[half + gap], 2_000, 'audio after the hole keeps its own position');
  });

  test('starts the window where both sides have audio', () => {
    const late = 3_000 * MS;

    const { seen, status } = collect((calibration) => {
      calibration.observeBacking(filled(REQUIRED * 2, 500), 0);
      // The phone only started streaming three seconds in. Those three seconds
      // are not an outage - nothing was captured to lose - so they must not be
      // rendered as silence, and must not read as lost audio.
      calibration.observeMic(filled(REQUIRED, 1_000), late);
    });

    assert.equal(status.state, 'complete', status.error ?? '');
    assert.equal(seen!.mic[0], 1_000, 'the window opens where the microphone does');
    assert.equal(seen!.backing[0], 500, 'and reads the song from the same moment');
  });

  test('refuses to measure across a large dropout', () => {
    const half = REQUIRED / 2;

    const { status } = collect((calibration) => {
      calibration.observeBacking(filled(REQUIRED, 500), 0);
      calibration.observeMic(filled(half, 1_000), 0);
      calibration.observeMic(filled(half, 2_000), half + 500 * MS);
    });

    assert.equal(status.state, 'failed');
    assert.match(status.error ?? '', /lost 500 ms of audio/);
  });

  test('a burst delivered at once still spans the time it covers', () => {
    const { seen, status } = collect((calibration) => {
      calibration.observeBacking(filled(REQUIRED, 500), 0);
      // Three frames released together by a congested link, each stating its
      // own position. Concatenating them would compress 60 ms into 20 ms.
      for (let i = 0; i < 3; i += 1) calibration.observeMic(filled(20 * MS, 1_000), i * 20 * MS);
      calibration.observeMic(filled(REQUIRED - 60 * MS, 2_000), 60 * MS);
    });

    assert.equal(status.state, 'complete', status.error ?? '');
    assert.equal(seen!.mic[60 * MS - 1], 1_000, 'the burst still occupies its full 60 ms');
    assert.equal(seen!.mic[60 * MS], 2_000);
  });
});

describe('CalibrationSession agreement', () => {
  /** Feeds windows whose analyser results are scripted in order. */
  function makeAgreeing(lags: number[], windows = 3) {
    let index = 0;
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context: () => ({
        sessionGeneration: 1, micGeneration: 10, backingGeneration: 20, sourceGeneration: 0,
      }),
      analyze: () => analysis(lags[Math.min(index++, lags.length - 1)]),
      agreementWindows: windows,
      agreementToleranceMs: 25,
      now: () => 0,
    });
    return calibration;
  }

  /** One full window on both sides, starting where the last one ended. */
  function window(calibration: CalibrationSession, index: number) {
    const at = index * REQUIRED;
    calibration.observeBacking(chunk(REQUIRED), at);
    calibration.observeMic(chunk(REQUIRED), at);
  }

  test('one window is not enough to apply an answer', () => {
    const calibration = makeAgreeing([240, 240, 240]);
    calibration.start(0);

    window(calibration, 0);
    assert.equal(calibration.result, null, 'a single window has nothing to be checked against');
    assert.equal(calibration.status().state, 'collecting', 'and it keeps measuring');
    assert.equal(calibration.status().windowsAgreed, 1);
  });

  test('applies once enough windows land on the same answer', () => {
    const calibration = makeAgreeing([240, 235, 244]);
    calibration.start(0);

    for (let i = 0; i < 3; i += 1) window(calibration, i);

    assert.equal(calibration.status().state, 'complete');
    assert.equal(calibration.result?.micLagMs, 244);
  });

  test('rejects the random answers a false positive produces', () => {
    // What unrelated audio actually did: a confident-looking lag, somewhere
    // different every time. No human is watching, so repeatability is the only
    // thing left that can tell these from a real match.
    const calibration = makeAgreeing([-870, 2_000, -1_380, 640]);
    calibration.start(0);

    for (let i = 0; i < 4; i += 1) window(calibration, i);

    assert.equal(calibration.result, null, 'nothing may be applied on disagreement');
    assert.equal(calibration.status().state, 'collecting');
  });

  test('a disagreeing window costs the progress it invalidates', () => {
    const calibration = makeAgreeing([240, 242, -900, -898]);
    calibration.start(0);

    window(calibration, 0);
    window(calibration, 1);
    assert.equal(calibration.status().windowsAgreed, 2, 'two in a row');

    window(calibration, 2);
    assert.equal(calibration.status().windowsAgreed, 1, 'the outlier resets the run');

    window(calibration, 3);
    assert.equal(calibration.status().windowsAgreed, 2, 'and the count rebuilds from it');
    assert.equal(calibration.result, null);
  });

  test('a settled run reports itself as fully agreed', () => {
    const calibration = makeAgreeing([100, 100, 100]);
    calibration.start(0);

    for (let i = 0; i < 3; i += 1) window(calibration, i);

    const status = calibration.status();
    assert.equal(status.windowsAgreed, 3);
    assert.equal(status.windowsNeeded, 3);
  });
});

describe('CalibrationSession agreement against the real analyser', () => {
  const REQUIRED_BYTES = REQUIRED * 2;

  function build(windows: number, seed: number, gain: number) {
    return toInt16(pulseTrain(REQUIRED * windows, RATE, seed), gain);
  }

  function windowOf(buffer: Buffer, index: number) {
    return new Int16Array(buffer.buffer, buffer.byteOffset + index * REQUIRED_BYTES, REQUIRED);
  }

  function run(mic: Buffer, backing: Buffer, windows: number) {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 600_000,
      context: () => ({
        sessionGeneration: 1, micGeneration: 10, backingGeneration: 20, sourceGeneration: 0,
      }),
      agreementWindows: 3,
      agreementToleranceMs: 25,
      maxLagMs: 700,
      now: () => 0,
    });

    calibration.start(0);
    for (let i = 0; i < windows; i += 1) {
      const at = i * REQUIRED;
      calibration.observeBacking(windowOf(backing, i), at);
      calibration.observeMic(windowOf(mic, i), at);
    }
    return calibration;
  }

  test('never applies an answer for two unrelated streams', () => {
    // The analyser accepts most unrelated pairs with a plausible confidence and
    // a lag it invents afresh each window. Measured over consecutive windows,
    // three in a row never land within 25 ms of each other - which is the whole
    // reason agreement is the filter rather than confidence.
    for (let seed = 1; seed <= 6; seed += 1) {
      const calibration = run(build(4, seed, 0.5), build(4, seed + 100, 0.8), 4);
      assert.equal(
        calibration.result,
        null,
        `unrelated audio (seed ${seed}) produced an applied answer: ${calibration.status().micLagMs} ms`,
      );
    }
  });

  test('still applies a real match, which does not move between windows', () => {
    const { mic, backing } = laggedPair(24, RATE, 260);
    const calibration = run(mic, backing, 4);

    assert.equal(calibration.status().state, 'complete', calibration.status().error ?? '');
    assert.ok(
      Math.abs((calibration.result?.micLagMs ?? 0) - 260) <= 15,
      `got ${calibration.result?.micLagMs} ms`,
    );
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
  const setup = (patch: Partial<CalibrationContext> = {}): CalibrationContext => ({
    sessionGeneration: 1,
    micGeneration: 10,
    backingGeneration: 20,
    sourceGeneration: 0,
    ...patch,
  });

  /** A completed measurement taken against the default setup. */
  function measured() {
    const harness = makeSession();
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);
    return harness;
  }

  test('holds for the setup it was measured against', () => {
    assert.equal(measured().calibration.isStaleFor(setup()), false);
  });

  test('is stale once the microphone starts a new capture', () => {
    assert.equal(measured().calibration.isStaleFor(setup({ micGeneration: 11 })), true);
  });

  test('is stale in a different live session', () => {
    assert.equal(measured().calibration.isStaleFor(setup({ sessionGeneration: 2 })), true);
  });

  test('is stale once the song comes from a different capture', () => {
    // A new tab capture can be a different device or output path, so it carries
    // its own delay. A socket reconnect keeps the generation and stays valid.
    assert.equal(measured().calibration.isStaleFor(setup({ backingGeneration: 21 })), true);
  });

  test('is stale once the desktop player has been seeked', () => {
    // The follower only corrects past 450 ms of error, so a seek can leave the
    // song anywhere in that band. The measured offset no longer describes it.
    assert.equal(measured().calibration.isStaleFor(setup({ sourceGeneration: 1 })), true);
  });

  test('records the capture that produced the samples, not the one at start', () => {
    const harness = makeSession();
    harness.calibration.start(0);

    // The phone restarts its capture midway; the answer describes what finished.
    harness.context = setup({ micGeneration: 12 });
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(harness.calibration.isStaleFor(setup({ micGeneration: 12 })), false);
    assert.equal(harness.calibration.isStaleFor(setup()), true);
  });

  test('nothing measured is never stale', () => {
    const { calibration } = makeSession();
    assert.equal(calibration.isStaleFor(setup({ sessionGeneration: 99 })), false);
  });
});

describe('CalibrationSession with the real analyser', () => {
  test('recovers an injected lag end to end', () => {
    const calibration = new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context: () => ({ sessionGeneration: 1, micGeneration: 1, backingGeneration: 1, sourceGeneration: 0 }),
    });
    const { mic, backing } = laggedPair(6, RATE, 320);

    calibration.start(0);
    calibration.observeBacking(new Int16Array(backing.buffer, backing.byteOffset, REQUIRED), 0);
    calibration.observeMic(new Int16Array(mic.buffer, mic.byteOffset, REQUIRED), 0);

    const status = calibration.status();
    assert.equal(status.state, 'complete', status.error ?? '');
    assert.ok(Math.abs((status.micLagMs ?? 0) - 320) <= 15, `got ${status.micLagMs} ms`);
  });
});
