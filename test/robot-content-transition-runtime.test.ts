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
      readMic: (_start, length) => new Int16Array(length).fill(10),
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

test('anchor retries only after safe pre-seek evidence grows', async () => {
  let evidenceSamples = 900;
  let anchorRuns = 0;
  const { runtime } = runtimeHarness({
    transitionEvidence: () => ({
      mic: new Int16Array(evidenceSamples),
      backing: new Int16Array(evidenceSamples),
    }),
    estimateRawLag: async () => {
      anchorRuns += 1;
      return null;
    },
  });

  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: null,
  }, 100);
  assert.equal(anchorRuns, 0, 'sub-second evidence cannot start an anchor worker');

  evidenceSamples = 1_500;
  runtime.noteMicProgress(120);
  await nextTurn();
  await nextTurn();
  assert.equal(anchorRuns, 1, 'newly sufficient evidence must retry the missing anchor');

  runtime.noteMicProgress(130);
  await nextTurn();
  assert.equal(anchorRuns, 1, 'the same evidence snapshot must not spin another worker');

  evidenceSamples = 2_000;
  runtime.noteMicProgress(140);
  await nextTurn();
  await nextTurn();
  assert.equal(anchorRuns, 2, 'a larger safe pre-seek window may retry an ambiguous anchor');
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
