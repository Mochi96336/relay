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
  analyze?: (
    mic: Int16Array,
    backing: Int16Array,
    rate: number,
    maxLagMs?: number,
    signal?: AbortSignal,
  ) => TimingCalibrationAnalysis | PromiseLike<TimingCalibrationAnalysis>;
  timeoutMs?: number;
  agreementWindows?: number;
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
    agreementWindows: options.agreementWindows,
    onSettled: () => { harness.settled += 1; },
  });

  return harness;
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

  test('standing a collection down does not report it as a failure', () => {
    // Something else taking priority is not evidence the measurement went
    // wrong, so the room must not be told a calibration error occurred.
    const harness = makeSession();
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED / 2, REQUIRED / 2);

    assert.equal(harness.calibration.abandon(), true);
    assert.equal(harness.calibration.status().state, 'idle');
    assert.equal(harness.calibration.status().error, null);
    assert.equal(harness.calibration.transactionActive, false);
    assert.equal(harness.settled, 1);

    harness.calibration.start(0);
    assert.equal(harness.calibration.status().progress, 0, 'no leftovers from the abandoned run');
  });

  test('standing down keeps the confirmed answer serving', () => {
    let lag = 240;
    const { calibration } = makeSession({ analyze: () => analysis(lag) });
    calibration.start(0);
    fill(calibration, REQUIRED, REQUIRED);
    assert.equal(calibration.result?.micLagMs, 240);

    lag = 999;
    calibration.start(0);
    fill(calibration, REQUIRED / 2, REQUIRED / 2);
    assert.equal(calibration.abandon(), true);

    assert.equal(calibration.status().state, 'complete');
    assert.equal(calibration.status().error, null);
    assert.equal(calibration.result?.micLagMs, 240);
    assert.equal(calibration.confirmedResult?.micLagMs, 240);
  });

  test('there is nothing to stand down outside a collection', () => {
    const harness = makeSession();
    assert.equal(harness.calibration.abandon(), false);

    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);
    assert.equal(harness.calibration.status().state, 'complete');
    assert.equal(harness.calibration.abandon(), false, 'a settled answer is not a run in flight');
    assert.equal(harness.calibration.result?.micLagMs, 240);
  });
});

describe('CalibrationSession asynchronous analysis', () => {
  test('keeps collecting until a worker result settles', async () => {
    const result = deferred<TimingCalibrationAnalysis>();
    const harness = makeSession({ analyze: () => result.promise });
    harness.calibration.start(0);

    fill(harness.calibration, REQUIRED, REQUIRED);
    assert.equal(harness.calibration.status().state, 'collecting');
    assert.equal(harness.settled, 0);
    assert.equal(harness.calibration.tick(999_999), false, 'worker time is not capture timeout');

    result.resolve(analysis(240));
    await nextTurn();

    assert.equal(harness.calibration.status().state, 'complete');
    assert.equal(harness.calibration.result?.micLagMs, 240);
    assert.equal(harness.settled, 1);
  });

  test('media-transition evidence stays readable while the analyser is still running', async () => {
    // A seek can land in the last moments of a calibration. Withholding the
    // window there told the transition gate there was no evidence at all, so
    // the seek was classified as a destructive bootstrap remap - invalidating
    // the run that was about to produce the content authority it needed.
    // `peekRecentWindow()` does not consume collection state, and a pending
    // analysis is the moment this session holds the most evidence, not the
    // least.
    const result = deferred<TimingCalibrationAnalysis>();
    const harness = makeSession({ analyze: () => result.promise });
    harness.calibration.start(0);

    // A full window plus a second of the audio that keeps arriving while the
    // worker runs. `takeReadyWindow()` consumes the analysed window, so this
    // trailing second is exactly the evidence a seek would need right now.
    fill(harness.calibration, REQUIRED + RATE, REQUIRED + RATE);
    assert.equal(harness.calibration.status().state, 'collecting');
    assert.equal(harness.calibration.status().progress, 1, 'a full window is being analysed');

    const evidence = harness.calibration.transitionEvidence(RATE);
    assert.notEqual(evidence, null, 'a pending analysis must not hide still-usable evidence');
    assert.equal(evidence?.mic.length, RATE);
    assert.equal(evidence?.backing.length, RATE);

    result.resolve(analysis(240));
    await nextTurn();
    assert.equal(harness.calibration.status().state, 'complete');
  });

  test('ignores a worker answer after the collection is reset', async () => {
    const result = deferred<TimingCalibrationAnalysis>();
    let workerSignal: AbortSignal | undefined;
    const harness = makeSession({
      analyze: (_mic, _backing, _rate, _maxLagMs, signal) => {
        workerSignal = signal;
        return result.promise;
      },
    });
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(workerSignal?.aborted, false);
    harness.calibration.reset();
    assert.equal(workerSignal?.aborted, true, 'reset cancels work the answer can no longer update');
    result.resolve(analysis(999));
    await nextTurn();

    assert.equal(harness.calibration.status().state, 'idle');
    assert.equal(harness.calibration.result, null);
    assert.equal(harness.settled, 0);
  });

  test('ignores a worker answer after the collection is stood down', async () => {
    const result = deferred<TimingCalibrationAnalysis>();
    let workerSignal: AbortSignal | undefined;
    const harness = makeSession({
      analyze: (_mic, _backing, _rate, _maxLagMs, signal) => {
        workerSignal = signal;
        return result.promise;
      },
    });
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    assert.equal(workerSignal?.aborted, false);
    assert.equal(harness.calibration.abandon(), true);
    assert.equal(workerSignal?.aborted, true, 'a stood-down run cancels the work it can no longer use');
    result.resolve(analysis(999));
    await nextTurn();

    assert.equal(harness.calibration.status().state, 'idle');
    assert.equal(harness.calibration.result, null);
  });

  test('retains the next agreement window while the first is being analyzed', async () => {
    const first = deferred<TimingCalibrationAnalysis>();
    const second = deferred<TimingCalibrationAnalysis>();
    let calls = 0;
    const harness = makeSession({
      agreementWindows: 2,
      analyze: () => (calls++ === 0 ? first.promise : second.promise),
    });
    harness.calibration.start(0);

    fill(harness.calibration, REQUIRED * 2, REQUIRED * 2);
    assert.equal(calls, 1, 'only one worker runs at a time');

    first.resolve(analysis(240));
    await nextTurn();
    assert.equal(calls, 2, 'the buffered second window starts after the first settles');

    second.resolve(analysis(245));
    await nextTurn();
    assert.equal(harness.calibration.status().state, 'complete');
    assert.equal(harness.calibration.result?.micLagMs, 245);
  });

  test('surfaces an asynchronous analyzer rejection', async () => {
    const result = deferred<TimingCalibrationAnalysis>();
    const harness = makeSession({ analyze: () => result.promise });
    harness.calibration.start(0);
    fill(harness.calibration, REQUIRED, REQUIRED);

    result.reject(new Error('worker failed safely'));
    await nextTurn();

    assert.equal(harness.calibration.status().state, 'failed');
    assert.match(harness.calibration.status().error ?? '', /worker failed safely/);
    assert.equal(harness.settled, 1);
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

  test('rejects a non-integer agreement window count', () => {
    assert.throws(
      () => makeAgreeing([100], 2.5),
      /agreementWindows must be a positive integer/,
    );
  });

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

  test('keeps a fast side\'s buffered next window while the slow side catches up', () => {
    const calibration = makeAgreeing([240, 240], 2);
    calibration.start(0);

    // Backing arrives as one large burst. Completing the first window must
    // consume only that window, not discard the second six seconds before the
    // microphone websocket delivers its matching range.
    calibration.observeBacking(chunk(REQUIRED * 2), 0);
    calibration.observeMic(chunk(REQUIRED * 2), 0);

    assert.equal(calibration.status().state, 'complete');
    assert.equal(calibration.result?.micLagMs, 240);
    assert.equal(calibration.status().windowsAgreed, 2);
  });

  test('keeps enough fast-side audio when the two captures start at different positions', () => {
    const calibration = makeAgreeing([240, 240], 2);
    calibration.start(0);

    // The shared origin is half a window into backing. Two full overlapping
    // windows therefore need backing to retain past its old fixed 2x cap.
    calibration.observeBacking(chunk(REQUIRED), 0);
    calibration.observeBacking(chunk(REQUIRED), REQUIRED);
    calibration.observeBacking(chunk(REQUIRED), REQUIRED * 2);
    calibration.observeMic(chunk(REQUIRED * 2), REQUIRED / 2);

    assert.equal(calibration.status().state, 'complete');
    assert.equal(calibration.result?.micLagMs, 240);
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

  test('does not report a full run when only each edge agrees with the newest value', () => {
    const calibration = makeAgreeing([-20, 20, 0]);
    calibration.start(0);

    for (let i = 0; i < 3; i += 1) window(calibration, i);

    assert.equal(calibration.status().state, 'collecting');
    assert.equal(calibration.status().windowsAgreed, 2, 'the full range exceeds tolerance');
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

describe('CalibrationSession provisional application', () => {
  function analysisWithConfidence(micLagMs: number, confidence: number): TimingCalibrationAnalysis {
    return { ...analysis(micLagMs), confidence };
  }

  /** Feeds windows whose analyser results (lag, confidence) are scripted in order. */
  function makeProvisional(
    results: [lag: number, confidence: number][],
    provisionalConfidence: number,
    windows = 3,
  ) {
    let index = 0;
    return new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context: () => ({
        sessionGeneration: 1, micGeneration: 10, backingGeneration: 20, sourceGeneration: 0,
      }),
      analyze: () => {
        const [lag, confidence] = results[Math.min(index++, results.length - 1)];
        return analysisWithConfidence(lag, confidence);
      },
      agreementWindows: windows,
      agreementToleranceMs: 25,
      provisionalConfidence,
      now: () => 0,
    });
  }

  function window(calibration: CalibrationSession, index: number) {
    const at = index * REQUIRED;
    calibration.observeBacking(chunk(REQUIRED), at);
    calibration.observeMic(chunk(REQUIRED), at);
  }

  test('a confident single window applies immediately, without waiting for agreement', () => {
    const calibration = makeProvisional([[175, 0.7], [-600, 0.5], [-320, 0.5]], 0.55);
    calibration.start(0);

    window(calibration, 0);
    assert.equal(calibration.result?.micLagMs, 175, 'applied on the first window');
    assert.equal(calibration.status().state, 'collecting', 'agreement is still running');
    assert.equal(calibration.status().provisional, true);
  });

  test('a window below the provisional threshold is not applied', () => {
    const calibration = makeProvisional([[175, 0.5], [175, 0.5], [175, 0.5]], 0.55);
    calibration.start(0);

    window(calibration, 0);
    assert.equal(calibration.result, null, 'not confident enough to trust alone');
    assert.equal(calibration.status().provisional, false);
  });

  test('agreement landing replaces the provisional value and clears the flag', () => {
    const calibration = makeProvisional(
      [[175, 0.7], [-600, 0.5], [244, 0.8], [235, 0.8], [250, 0.8]],
      0.55,
    );
    calibration.start(0);

    window(calibration, 0);
    assert.equal(calibration.result?.micLagMs, 175, 'the provisional guess');
    assert.equal(calibration.status().provisional, true);

    window(calibration, 1); // disagrees, discarded, provisional guess stands
    assert.equal(calibration.result?.micLagMs, 175);

    window(calibration, 2);
    window(calibration, 3);
    window(calibration, 4);

    assert.equal(calibration.status().state, 'complete');
    assert.equal(calibration.status().provisional, false, 'a confirmed answer is not provisional');
    // The applied value is the newest agreeing window's own reading (250), not
    // the discarded provisional guess (175) or an earlier agreeing one (244).
    assert.equal(calibration.result?.micLagMs, 250);
  });

  test('standing a run down revokes the provisional value it applied', () => {
    const calibration = makeProvisional([[175, 0.7], [-600, 0.5], [-320, 0.5]], 0.55);
    calibration.start(0);
    window(calibration, 0);
    assert.equal(calibration.result?.micLagMs, 175);

    assert.equal(calibration.abandon(), true);
    assert.equal(calibration.result, null, 'a guess belongs to the run that made it');
    assert.equal(calibration.status().provisional, false);
    assert.equal(calibration.status().error, null);
  });

  test('a later provisional window can replace an earlier one', () => {
    const calibration = makeProvisional([[175, 0.6], [-600, 0.65]], 0.55);
    calibration.start(0);

    window(calibration, 0);
    assert.equal(calibration.result?.micLagMs, 175);

    window(calibration, 1); // still disagrees with the first, but is itself confident
    assert.equal(calibration.result?.micLagMs, -600, 'the newer guess, not stuck on the first');
    assert.equal(calibration.status().provisional, true);
  });

  test('a confirmed answer is not overwritten by a later disagreeing window, provisional or not', () => {
    const calibration = makeProvisional(
      [[244, 0.8], [235, 0.8], [250, 0.8], [-600, 0.9]],
      0.55,
    );
    calibration.start(0);
    for (let i = 0; i < 3; i += 1) window(calibration, i);
    assert.equal(calibration.result?.micLagMs, 250, 'confirmed, on the newest agreeing window');

    // A fresh run (a reconnect, a re-triggered auto-calibration) starts collecting
    // again without discarding the confirmed answer - same invariant a plain
    // disagreeing window already had, now checked with provisional application on.
    calibration.start(1);
    window(calibration, 3);
    assert.equal(calibration.result?.micLagMs, 250, 'the confirmed answer, untouched');
    assert.equal(calibration.status().provisional, false);
  });

  test('provisional application is off unless explicitly enabled', () => {
    const calibration = makeAgreeingWithoutProvisional([175, -600, -320]);
    calibration.start(0);

    window(calibration, 0);
    assert.equal(calibration.result, null, 'the old silent-until-agreed behaviour by default');
  });

  function makeAgreeingWithoutProvisional(lags: number[]) {
    let index = 0;
    return new CalibrationSession({
      sampleRate: RATE,
      durationMs: DURATION_MS,
      timeoutMs: 20_000,
      context: () => ({
        sessionGeneration: 1, micGeneration: 10, backingGeneration: 20, sourceGeneration: 0,
      }),
      analyze: () => analysisWithConfidence(lags[Math.min(index++, lags.length - 1)], 0.8),
      agreementWindows: 3,
      agreementToleranceMs: 25,
      now: () => 0,
    });
  }
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
