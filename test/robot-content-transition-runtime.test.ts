import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RobotContentTransitionRuntime,
  type RobotContentTransitionCommitPlan,
  type RobotContentTransitionContext,
} from '../src/robot-content-transition-runtime.js';

const context: RobotContentTransitionContext = {
  sessionGeneration: 1,
  micGeneration: 2,
  backingGeneration: 3,
  sourceGeneration: 4,
};

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function runtimeHarness(overrides: {
  now?: () => number;
  currentDeltaMs?: () => number | null;
  backingTotalSamples?: () => number;
  micTotalSamples?: () => number;
  transitionEvidence?: (maxSamples: number) => { mic: Int16Array; backing: Int16Array } | null;
  readMic?: (start: number, length: number) => Int16Array;
  readBackingEvidence?: (start: number, length: number) => { gapSamples: number; frontierMissingSamples: number };
  readMicEvidence?: (start: number, length: number) => { gapSamples: number; frontierMissingSamples: number };
  commit?: (plan: RobotContentTransitionCommitPlan, nowMs: number) => boolean;
  estimateRawLag?: ConstructorParameters<typeof RobotContentTransitionRuntime>[0]['estimateRawLag'];
  compareHypotheses?: ConstructorParameters<typeof RobotContentTransitionRuntime>[0]['compareHypotheses'];
} = {}) {
  let degraded: ReturnType<RobotContentTransitionRuntime['status']> | null = null;
  const runtime = new RobotContentTransitionRuntime({
    sampleRate: 1_000,
    historySamples: 3_000,
    windowSamples: 100,
    maxLagMs: 500,
    maxEvidenceGapMs: 25,
    toleranceMs: 25,
    retentionSamples: 3_000,
    bounds: {
      lifetimeMs: 5_000,
      maxWindows: 4,
      maxWorkerFailures: 2,
    },
    host: {
      context: () => ({ ...context }),
      currentDeltaMs: overrides.currentDeltaMs ?? (() => 0),
      backingTotalSamples: overrides.backingTotalSamples ?? (() => 2_000),
      micTotalSamples: overrides.micTotalSamples ?? (() => 2_000),
      readBacking: (_start, length) => new Int16Array(length).fill(10),
      readMic: overrides.readMic ?? ((_start, length) => new Int16Array(length).fill(10)),
      readBackingEvidence: overrides.readBackingEvidence
        ?? (() => ({ gapSamples: 0, frontierMissingSamples: 0 })),
      readMicEvidence: overrides.readMicEvidence
        ?? (() => ({ gapSamples: 0, frontierMissingSamples: 0 })),
      transitionEvidence: overrides.transitionEvidence ?? (() => null),
      commit: overrides.commit ?? (() => true),
      onDegraded: (status) => {
        degraded = { ...status, quarantined: true } as ReturnType<RobotContentTransitionRuntime['status']>;
      },
    },
    now: overrides.now,
    estimateRawLag: overrides.estimateRawLag,
    compareHypotheses: overrides.compareHypotheses,
  });
  return {
    runtime,
    degraded: () => degraded,
  };
}

function beginConfirmed(runtime: RobotContentTransitionRuntime) {
  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
    playbackRate: 1,
  }, 100);
}

test('matching backing frontier is consumed once but does not itself commit content', () => {
  const { runtime } = runtimeHarness();
  beginConfirmed(runtime);

  const request = runtime.requestBackingBoundary(3);
  assert.deepEqual(request, { requestId: 1, backingGeneration: 3 });
  assert.equal(runtime.requestBackingBoundary(3), null, 'only one frontier request may be pending');

  assert.equal(runtime.acceptBackingBoundary({
    requestId: 1,
    generation: 3,
    firstSampleIndex: 240,
    currentBackingGeneration: 3,
    context,
  }), true);
  assert.equal(runtime.status(120).state, 'verifying');
  assert.equal(runtime.quarantined, true, 'transport order alone never releases quarantine');
  assert.equal(runtime.requestBackingBoundary(3), null, 'accepted frontier remains attached to this transition');
});

test('malformed matching frontier reply is consumed without granting mapping', () => {
  const { runtime } = runtimeHarness();
  beginConfirmed(runtime);

  assert.deepEqual(runtime.requestBackingBoundary(3), { requestId: 1, backingGeneration: 3 });
  assert.equal(runtime.acceptBackingBoundary({
    requestId: 1,
    generation: 99,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context,
  }), false);
  assert.deepEqual(
    runtime.requestBackingBoundary(3),
    { requestId: 2, backingGeneration: 3 },
    'a later fresh offset may request a new frontier after malformed metadata',
  );
});

test('confirmed content authority does not request anchor history', () => {
  const historyRequests: number[] = [];
  const { runtime } = runtimeHarness({
    transitionEvidence: (maxSamples) => {
      historyRequests.push(maxSamples);
      return null;
    },
  });

  beginConfirmed(runtime);
  assert.deepEqual(historyRequests, []);
});

test('late anchor completion cannot revive a cleared transition', async () => {
  let resolveAnchor: ((value: { rawLagMs: number; score: number; peakMargin: number; supportingBands: number }) => void) | null = null;
  const anchorPromise = new Promise<{ rawLagMs: number; score: number; peakMargin: number; supportingBands: number }>((resolve) => {
    resolveAnchor = resolve;
  });
  let compares = 0;
  const historyRequests: number[] = [];
  const { runtime } = runtimeHarness({
    transitionEvidence: (maxSamples) => {
      historyRequests.push(maxSamples);
      return {
        mic: new Int16Array(1_500),
        backing: new Int16Array(1_500),
      };
    },
    estimateRawLag: async () => anchorPromise,
    compareHypotheses: async () => {
      compares += 1;
      return {
        verdict: 'post',
        preScore: 0,
        postScore: 1,
        preSupportingBands: 0,
        postSupportingBands: 4,
      };
    },
  });

  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: null,
    playbackRate: 1,
  }, 100);
  assert.deepEqual(historyRequests, [3_000], 'runtime owns the bounded anchor-history request');
  assert.equal(runtime.status(100).state, 'verifying');

  runtime.clear();
  resolveAnchor!({ rawLagMs: 750, score: 1, peakMargin: 1, supportingBands: 4 });
  await nextTurn();
  await nextTurn();

  assert.equal(runtime.status(200).state, 'idle');
  assert.equal(compares, 0, 'stale worker completion must not schedule comparison work');
});

test('post evidence commits only after the acknowledged transport floor and current mapping agree', async () => {
  const commitPlans: RobotContentTransitionCommitPlan[] = [];
  const { runtime } = runtimeHarness({
    currentDeltaMs: () => 0,
    commit: (plan) => {
      commitPlans.push(plan);
      return true;
    },
    compareHypotheses: async () => ({
      verdict: 'post',
      preScore: 0.1,
      postScore: 0.9,
      preSupportingBands: 3,
      postSupportingBands: 5,
    }),
  });
  beginConfirmed(runtime);
  const request = runtime.requestBackingBoundary(3)!;
  assert.equal(runtime.acceptBackingBoundary({
    requestId: request.requestId,
    generation: 3,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context,
  }), true);

  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 0,
    sourceSampleCount: 1_000,
    sourceSampleRate: 1_000,
    samples: new Int16Array(1_000).fill(7),
    start: 0,
    backingTotalSamples: 1_000,
  }, 120);
  await nextTurn();
  await nextTurn();

  const commitPlan = commitPlans[0];
  assert.ok(commitPlan);
  assert.equal(commitPlan.boundarySample, 0);
  assert.equal(commitPlan.discardWorkingEvidence, false);
  assert.equal(commitPlan.confirmedPreChunks.length, 0);
  assert.equal(commitPlan.postChunks.length, 1);
  assert.equal(commitPlan.postChunks[0].start, 0);
  assert.equal(commitPlan.postChunks[0].samples.length, 1_000);
  assert.equal(runtime.status(130).state, 'idle');
});

test('Mic progress resumes a transition that already has enough backing evidence', async () => {
  let micTotalSamples = 0;
  let compares = 0;
  const commitPlans: RobotContentTransitionCommitPlan[] = [];
  const { runtime } = runtimeHarness({
    currentDeltaMs: () => 0,
    backingTotalSamples: () => 100,
    micTotalSamples: () => micTotalSamples,
    commit: (plan) => {
      commitPlans.push(plan);
      return true;
    },
    compareHypotheses: async () => {
      compares += 1;
      return {
        verdict: 'post',
        preScore: 0.1,
        postScore: 0.9,
        preSupportingBands: 3,
        postSupportingBands: 5,
      };
    },
  });
  beginConfirmed(runtime);
  const request = runtime.requestBackingBoundary(3)!;
  assert.equal(runtime.acceptBackingBoundary({
    requestId: request.requestId,
    generation: 3,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context,
  }), true);

  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 0,
    sourceSampleCount: 100,
    sourceSampleRate: 1_000,
    samples: new Int16Array(100).fill(7),
    start: 0,
    backingTotalSamples: 100,
  }, 120);
  await nextTurn();
  assert.equal(compares, 0, 'backing alone cannot analyze before both Mic hypotheses are readable');
  assert.equal(runtime.status(125).state, 'verifying');

  micTotalSamples = 1_000;
  runtime.noteMicProgress(130);
  await nextTurn();
  await nextTurn();

  assert.equal(compares, 1);
  assert.equal(commitPlans.length, 1);
  assert.equal(commitPlans[0].boundarySample, 0);
  assert.equal(runtime.status(140).state, 'idle');
});

test('a compare window with too much missing PCM is skipped before worker analysis', async () => {
  let compares = 0;
  const commitPlans: RobotContentTransitionCommitPlan[] = [];
  const { runtime } = runtimeHarness({
    currentDeltaMs: () => 0,
    backingTotalSamples: () => 200,
    micTotalSamples: () => 2_000,
    readBackingEvidence: (start) => ({
      gapSamples: start === 0 ? 26 : 0,
      frontierMissingSamples: 0,
    }),
    commit: (plan) => {
      commitPlans.push(plan);
      return true;
    },
    compareHypotheses: async () => {
      compares += 1;
      return {
        verdict: 'post',
        preScore: 0.1,
        postScore: 0.9,
        preSupportingBands: 3,
        postSupportingBands: 5,
      };
    },
  });
  beginConfirmed(runtime);
  const request = runtime.requestBackingBoundary(3)!;
  assert.equal(runtime.acceptBackingBoundary({
    requestId: request.requestId,
    generation: 3,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context,
  }), true);

  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 0,
    sourceSampleCount: 200,
    sourceSampleRate: 1_000,
    samples: new Int16Array(200).fill(7),
    start: 0,
    backingTotalSamples: 200,
  }, 120);
  await nextTurn();

  assert.equal(compares, 0, 'a sparse window must never reach the correlator');
  const skipped = runtime.status(125);
  assert.equal(skipped.state, 'verifying');
  assert.ok('windowsStarted' in skipped);
  assert.ok('workerInvocations' in skipped);
  assert.equal(skipped.windowsStarted, 0, 'rejected source evidence is not a compare attempt');
  assert.equal(skipped.workerInvocations, 0, 'no worker ran for a rejected source range');

  // The permanent bad range has advanced out of the way. A later progress event
  // may classify the next clean window, but the unclassified working span makes
  // replay unsafe even when the mapping boundary itself is proved.
  runtime.noteMicProgress(130);
  await nextTurn();
  await nextTurn();

  assert.equal(compares, 1);
  assert.equal(commitPlans.length, 1);
  assert.equal(commitPlans[0].boundarySample, 100);
  assert.equal(commitPlans[0].discardWorkingEvidence, true);
  assert.equal(commitPlans[0].confirmedPreChunks.length, 0);
  assert.equal(commitPlans[0].postChunks.length, 0);
});

test('post evidence that disagrees with current mapping stays quarantined and is never replayed later', async () => {
  let currentDeltaMs = 500;
  let backingTotalSamples = 100;
  const commitPlans: RobotContentTransitionCommitPlan[] = [];
  const { runtime } = runtimeHarness({
    currentDeltaMs: () => currentDeltaMs,
    backingTotalSamples: () => backingTotalSamples,
    commit: (plan) => {
      commitPlans.push(plan);
      return true;
    },
    compareHypotheses: async () => ({
      verdict: 'post',
      preScore: 0.1,
      postScore: 0.9,
      preSupportingBands: 3,
      postSupportingBands: 5,
    }),
  });
  beginConfirmed(runtime);
  const request = runtime.requestBackingBoundary(3)!;
  runtime.acceptBackingBoundary({
    requestId: request.requestId,
    generation: 3,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context,
  });
  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 0,
    sourceSampleCount: 100,
    sourceSampleRate: 1_000,
    samples: new Int16Array(100).fill(7),
    start: 0,
    backingTotalSamples: 100,
  }, 120);
  await nextTurn();
  await nextTurn();

  assert.equal(commitPlans.length, 0);
  assert.equal(runtime.status(130).state, 'verifying');
  assert.equal(runtime.quarantined, true);

  currentDeltaMs = 0;
  backingTotalSamples = 200;
  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 100,
    sourceSampleCount: 100,
    sourceSampleRate: 1_000,
    samples: new Int16Array(100).fill(8),
    start: 100,
    backingTotalSamples: 200,
  }, 140);
  await nextTurn();
  await nextTurn();

  assert.equal(commitPlans.length, 1);
  const commitPlan = commitPlans[0];
  assert.equal(commitPlan.boundarySample, 100);
  assert.equal(commitPlan.discardWorkingEvidence, true);
  assert.equal(commitPlan.confirmedPreChunks.length, 0);
  assert.equal(commitPlan.postChunks.length, 0, 'mismatched working evidence must never be replayed later');
  assert.equal(runtime.status(150).state, 'idle');
});

test('deadline degradation aborts work and remains fail-closed until a later concrete transition', () => {
  let nowMs = 100;
  const { runtime, degraded } = runtimeHarness({ now: () => nowMs });
  beginConfirmed(runtime);
  nowMs = 5_101;

  assert.equal(runtime.sweep(nowMs), true);
  assert.equal(runtime.status(nowMs).state, 'degraded');
  assert.equal(runtime.status(nowMs).quarantined, true);
  const degradedStatus = degraded();
  assert.ok(degradedStatus);
  assert.equal(degradedStatus.state, 'degraded');
  assert.ok('degradedReason' in degradedStatus);
  assert.equal(degradedStatus.degradedReason, 'deadline-exceeded');
  assert.equal(runtime.requestBackingBoundary(3), null, 'degraded transition cannot acquire new transport evidence');
});

test('a repeated transition at the same rate carries its bounded lifetime', () => {
  let now = 0;
  const { runtime } = runtimeHarness({ now: () => now });
  const begin = (playbackRate: number) => runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
    playbackRate,
  });

  begin(1);
  now = 1_000;
  begin(1);

  // Same context, same media jump, same conversion: one continuing attempt, so
  // it keeps the deadline it started under rather than buying a fresh one.
  const carried = runtime.status();
  assert.equal(carried.quarantined, true);
  assert.equal('ageMs' in carried ? carried.ageMs : null, 1_000);
});

test('a rate change cannot carry evidence classified under the old rate', () => {
  let now = 0;
  const { runtime } = runtimeHarness({ now: () => now });
  const begin = (playbackRate: number) => runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
    playbackRate,
  });

  begin(1);
  now = 1_000;
  begin(2);

  // The media jump is identical, but at 2x it describes half as many capture
  // samples. Windows the previous attempt had already classified answer a
  // different question now, so this is a new transaction and not a retry.
  const restarted = runtime.status();
  assert.equal(restarted.quarantined, true);
  assert.equal('ageMs' in restarted ? restarted.ageMs : null, 0);
});

test('the post-seek hypothesis is looked for at the wall-time distance the rate implies', async () => {
  // sampleRate is 1_000 here, so one wall millisecond is exactly one sample.
  // The seek jumps 500 ms of media backwards; at 2x that is 250 ms of real
  // audio, so the post-seek vocal sits 250 samples from the pre-seek one -
  // not 500. Looking in the wrong place can only ever fail closed.
  const micStarts: number[] = [];
  const { runtime } = runtimeHarness({
    micTotalSamples: () => 10_000,
    backingTotalSamples: () => 10_000,
    readMic: (start, length) => {
      micStarts.push(start);
      return new Int16Array(length).fill(10);
    },
    compareHypotheses: async () => ({
      verdict: 'post' as const,
      preScore: 0.1,
      postScore: 0.9,
      preSupportingBands: 3,
      postSupportingBands: 5,
    }),
  });

  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
    playbackRate: 2,
  });
  const request = runtime.requestBackingBoundary(3)!;
  runtime.acceptBackingBoundary({
    requestId: request.requestId,
    generation: 3,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context,
  });
  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 0,
    sourceSampleCount: 1_000,
    sourceSampleRate: 1_000,
    samples: new Int16Array(1_000).fill(7),
    start: 0,
    backingTotalSamples: 1_000,
  }, 120);
  await nextTurn();

  // preRawLag = 750 (the confirmed reference; both deltas are equal here).
  // postRawLag = 750 + (-500 ms of media)/2 = 500.
  assert.deepEqual(micStarts, [750, 500]);
});

test('a new content authority mid-transition cannot inherit the old one classifications', async () => {
  // Same streams, same media jump, same rate - but the hypothesis positions are
  // measured from the confirmed content authority. A validator that promotes a
  // corrected lag while a transition is verifying leaves the PRE ranges it
  // already classified answering the previous authority's question.
  let now = 0;
  const { runtime } = runtimeHarness({ now: () => now });
  const begin = (confirmedReferenceLagMs: number | null) => runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs,
    playbackRate: 1,
  });

  begin(750);
  now = 1_000;
  begin(750);
  const carried = runtime.status();
  assert.equal('ageMs' in carried ? carried.ageMs : null, 1_000, 'an unchanged authority is one continuing attempt');

  now = 2_000;
  begin(820);
  const restarted = runtime.status();
  assert.equal('ageMs' in restarted ? restarted.ageMs : null, 0, 'a moved authority starts a new transaction');
});

test('losing content authority entirely also refuses to inherit its classifications', async () => {
  let now = 0;
  const { runtime } = runtimeHarness({ now: () => now });
  const begin = (confirmedReferenceLagMs: number | null) => runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs,
    playbackRate: 1,
  });

  begin(750);
  now = 1_000;
  // Null means the lags now come from an anchor estimate instead, which is a
  // different basis, not a weaker version of the same one.
  begin(null);
  const restarted = runtime.status();
  assert.equal('ageMs' in restarted ? restarted.ageMs : null, 0);
});
