import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ContentCalibrationValidator,
  type ConfirmedContentCalibration,
} from '../src/content-calibration-validator.js';
import type { CalibrationContext } from '../src/calibration-session.js';
import type { TimingCalibrationAnalysis } from '../src/timing-calibration.js';

const RATE = 48_000;
const DURATION_MS = 6_000;
const WINDOW = RATE * 6;
const MS = RATE / 1_000;

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

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(options: {
  results?: Array<TimingCalibrationAnalysis | Error>;
  enabled?: boolean;
} = {}) {
  let now = 0;
  let resultIndex = 0;
  let changeCount = 0;
  const results = options.results ?? [analysis(310)];
  const promotions: Array<{ result: TimingCalibrationAnalysis; context: CalibrationContext }> = [];
  const context: CalibrationContext = {
    sessionGeneration: 1,
    micGeneration: 10,
    backingGeneration: 20,
    sourceGeneration: 0,
  };

  const validator = new ContentCalibrationValidator({
    sampleRate: RATE,
    durationMs: DURATION_MS,
    timeoutMs: 20_000,
    intervalMs: 30_000,
    retryMs: 10_000,
    deviationThresholdMs: 30,
    agreementToleranceMs: 25,
    context: () => context,
    enabled: options.enabled,
    now: () => now,
    analyze: () => {
      const scripted = results[Math.min(resultIndex++, results.length - 1)];
      if (scripted instanceof Error) throw scripted;
      return scripted;
    },
    onChange: () => { changeCount += 1; },
    onDriftConfirmed: (result, promotedContext) => {
      promotions.push({ result, context: promotedContext });
    },
  });

  const baseline: ConfirmedContentCalibration = {
    micLagMs: 310,
    confidence: 0.85,
    segmentLagsMs: [310, 310, 310],
    context: { ...context },
  };
  validator.setBaseline(baseline, now);

  return {
    validator,
    promotions,
    context,
    setNow(value: number) { now = value; },
    get now() { return now; },
    get changeCount() { return changeCount; },
  };
}

function fullWindow(harness: Harness, index: number) {
  const at = index * WINDOW;
  harness.validator.observeBacking(new Int16Array(WINDOW), at);
  harness.validator.observeMic(new Int16Array(WINDOW), at);
}

function startDue(harness: Harness, nowMs: number) {
  harness.setNow(nowMs);
  assert.equal(harness.validator.maybeStart(nowMs), true);
}

describe('ContentCalibrationValidator scheduling', () => {
  test('waits the normal interval after a confirmed baseline', () => {
    const harness = makeHarness();

    harness.setNow(29_999);
    assert.equal(harness.validator.maybeStart(), false);
    assert.equal(harness.validator.status().state, 'waiting');

    harness.setNow(30_000);
    assert.equal(harness.validator.maybeStart(), true);
    assert.equal(harness.validator.status().state, 'collecting');
  });

  test('disabled validation keeps the baseline but never starts collection', () => {
    const harness = makeHarness({ enabled: false });
    harness.setNow(60_000);

    assert.equal(harness.validator.hasBaseline, true);
    assert.equal(harness.validator.maybeStart(), false);
    assert.equal(harness.validator.status().state, 'inactive');
  });

  test('timeout invalidates only the observation and retries later', () => {
    const harness = makeHarness();
    startDue(harness, 30_000);

    harness.setNow(50_001);
    assert.equal(harness.validator.tick(), true);
    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'invalid');
    assert.equal(status.baselineLagMs, 310);
    assert.equal(status.nextValidationInMs, 10_000);
  });
});

describe('ContentCalibrationValidator truthful change notifications', () => {
  test('baseline seed and collection start both notify immediately', () => {
    const harness = makeHarness();
    assert.equal(harness.changeCount, 1, 'setBaseline must publish waiting baseline truth');

    startDue(harness, 30_000);
    assert.equal(harness.changeCount, 2, 'starting collection must publish collecting truth');
  });

  test('stable analysis notifies without waiting for the next schedule tick', () => {
    const harness = makeHarness({ results: [analysis(325)] });
    startDue(harness, 30_000);
    const before = harness.changeCount;
    fullWindow(harness, 0);

    assert.equal(harness.validator.status().lastOutcome, 'stable');
    assert.equal(harness.changeCount, before + 1);
  });

  test('suspect then inconclusive each notify at the evidence boundary', () => {
    const harness = makeHarness({ results: [analysis(370), analysis(410)] });
    startDue(harness, 30_000);
    const beforeSuspect = harness.changeCount;
    fullWindow(harness, 0);
    assert.equal(harness.validator.status().lastOutcome, 'suspect');
    assert.equal(harness.changeCount, beforeSuspect + 1);

    assert.equal(harness.validator.maybeStart(), true);
    const beforeInconclusive = harness.changeCount;
    fullWindow(harness, 1);
    assert.equal(harness.validator.status().lastOutcome, 'inconclusive');
    assert.equal(harness.changeCount, beforeInconclusive + 1);
  });

  test('invalid analysis and cancel notify immediately', () => {
    const harness = makeHarness({ results: [new Error('ambiguous peak')] });
    startDue(harness, 30_000);
    const beforeInvalid = harness.changeCount;
    fullWindow(harness, 0);
    assert.equal(harness.validator.status().lastOutcome, 'invalid');
    assert.equal(harness.changeCount, beforeInvalid + 1);

    harness.setNow(40_000);
    assert.equal(harness.validator.maybeStart(), true);
    const beforeCancel = harness.changeCount;
    harness.validator.cancel(40_001);
    assert.equal(harness.changeCount, beforeCancel + 1);
  });
});

describe('ContentCalibrationValidator drift policy', () => {
  test('a stable measurement never rewrites the baseline', () => {
    const harness = makeHarness({ results: [analysis(328)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);

    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'stable');
    assert.equal(status.lastMeasuredLagMs, 328);
    assert.equal(status.lastDeltaMs, 18);
    assert.equal(status.baselineLagMs, 310);
    assert.equal(harness.promotions.length, 0);
  });

  test('one large deviation becomes suspect but cannot change timing authority', () => {
    const harness = makeHarness({ results: [analysis(370)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);

    const status = harness.validator.status();
    assert.equal(status.state, 'suspect');
    assert.equal(status.lastOutcome, 'suspect');
    assert.equal(status.suspectLagMs, 370);
    assert.equal(status.baselineLagMs, 310);
    assert.equal(status.nextValidationInMs, 0);
    assert.equal(harness.promotions.length, 0);
  });

  test('two consecutive agreeing deviations promote the newest measurement', () => {
    const harness = makeHarness({ results: [analysis(370, 0.82), analysis(365, 0.77)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.promotions.length, 0, 'the first deviation has no authority');

    assert.equal(harness.validator.maybeStart(), true, 'suspect confirmation starts without 30 s wait');
    fullWindow(harness, 1);

    assert.equal(harness.promotions.length, 1);
    assert.equal(harness.promotions[0].result.micLagMs, 365, 'promote newest evidence, not an average');
    assert.equal(harness.promotions[0].result.confidence, 0.77);
    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'drift-confirmed');
    assert.equal(status.baselineLagMs, 365);
    assert.equal(status.suspectLagMs, null);
  });

  test('a stable confirmation cancels a transient suspect', () => {
    const harness = makeHarness({ results: [analysis(370), analysis(315)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.validator.maybeStart(), true);
    fullWindow(harness, 1);

    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'stable');
    assert.equal(status.baselineLagMs, 310);
    assert.equal(status.suspectLagMs, null);
    assert.equal(harness.promotions.length, 0);
  });

  test('opposite-direction deviations do not confirm drift', () => {
    const harness = makeHarness({ results: [analysis(370), analysis(255)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.validator.maybeStart(), true);
    fullWindow(harness, 1);

    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'inconclusive');
    assert.equal(status.baselineLagMs, 310);
    assert.equal(status.suspectLagMs, null);
    assert.equal(harness.promotions.length, 0);
  });

  test('same-direction deviations outside agreement tolerance do not confirm drift', () => {
    const harness = makeHarness({ results: [analysis(370), analysis(410)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.validator.maybeStart(), true);
    fullWindow(harness, 1);

    assert.equal(harness.validator.status().lastOutcome, 'inconclusive');
    assert.equal(harness.validator.status().baselineLagMs, 310);
    assert.equal(harness.promotions.length, 0);
  });

  test('an analyser rejection preserves the baseline and clears suspect evidence', () => {
    const harness = makeHarness({ results: [analysis(370), new Error('ambiguous peak')] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.validator.maybeStart(), true);
    fullWindow(harness, 1);

    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'invalid');
    assert.equal(status.baselineLagMs, 310);
    assert.equal(status.suspectLagMs, null);
    assert.equal(status.nextValidationInMs, 10_000);
    assert.equal(harness.promotions.length, 0);
  });

  test('more than 300 ms of capture gap is invalid evidence, not drift', () => {
    const harness = makeHarness({ results: [analysis(370)] });
    startDue(harness, 30_000);

    const half = WINDOW / 2;
    harness.validator.observeBacking(new Int16Array(WINDOW), 0);
    harness.validator.observeMic(new Int16Array(half), 0);
    harness.validator.observeMic(new Int16Array(half), half + 500 * MS);

    const status = harness.validator.status();
    assert.equal(status.lastOutcome, 'invalid');
    assert.equal(status.baselineLagMs, 310);
    assert.equal(status.suspectLagMs, null);
    assert.equal(harness.promotions.length, 0);
  });
});

describe('ContentCalibrationValidator authority boundaries', () => {
  test('a context change clears the baseline instead of treating it as drift', () => {
    const harness = makeHarness();
    harness.context.micGeneration = 11;
    harness.setNow(30_000);

    assert.equal(harness.validator.maybeStart(), false);
    const status = harness.validator.status();
    assert.equal(status.state, 'inactive');
    assert.equal(status.baselineLagMs, null);
  });

  test('structural invalidation clears stale validation diagnostics', () => {
    const harness = makeHarness({ results: [analysis(325)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.validator.status().lastOutcome, 'stable');

    harness.context.sourceGeneration = 1;
    harness.setNow(60_000);
    assert.equal(harness.validator.maybeStart(), false);
    const status = harness.validator.status();
    assert.equal(status.baselineLagMs, null);
    assert.equal(status.lastMeasuredLagMs, null);
    assert.equal(status.lastDeltaMs, null);
    assert.equal(status.lastOutcome, null);
  });

  test('a context change during collection cannot be promoted', () => {
    const harness = makeHarness({ results: [analysis(370)] });
    startDue(harness, 30_000);
    harness.context.sourceGeneration = 1;
    fullWindow(harness, 0);

    assert.equal(harness.validator.status().baselineLagMs, null);
    assert.equal(harness.promotions.length, 0);
  });

  test('cancel discards suspect evidence and requires a fresh pair after readiness returns', () => {
    const harness = makeHarness({ results: [analysis(370), analysis(365)] });
    startDue(harness, 30_000);
    fullWindow(harness, 0);
    assert.equal(harness.validator.status().state, 'suspect');

    harness.validator.cancel(31_000);
    let status = harness.validator.status(31_000);
    assert.equal(status.suspectLagMs, null);
    assert.equal(status.nextValidationInMs, 10_000);

    harness.setNow(41_000);
    assert.equal(harness.validator.maybeStart(), true);
    fullWindow(harness, 1);
    status = harness.validator.status();
    assert.equal(status.lastOutcome, 'suspect', 'the later deviation starts a new pair');
    assert.equal(harness.promotions.length, 0);
  });
});
