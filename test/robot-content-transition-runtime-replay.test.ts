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

function beginShifted(runtime: RobotContentTransitionRuntime, nowMs: number) {
  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 600,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
  }, nowMs);
}

test('compatible restart carries proven pre evidence and replays it at the preserved pre-shift', async () => {
  let currentDeltaMs = 0;
  let backingTotalSamples = 100;
  let comparisons = 0;
  const commitPlans: RobotContentTransitionCommitPlan[] = [];
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
      currentDeltaMs: () => currentDeltaMs,
      backingTotalSamples: () => backingTotalSamples,
      micTotalSamples: () => 2_000,
      readBacking: (_start, length) => new Int16Array(length).fill(10),
      readMic: (_start, length) => new Int16Array(length).fill(10),
      transitionEvidence: () => null,
      commit: (plan) => {
        commitPlans.push(plan);
        return true;
      },
    },
    compareHypotheses: async () => {
      comparisons += 1;
      return comparisons === 1
        ? {
            verdict: 'pre',
            preScore: 0.9,
            postScore: 0.1,
            preSupportingBands: 5,
            postSupportingBands: 3,
          }
        : {
            verdict: 'post',
            preScore: 0.1,
            postScore: 0.9,
            preSupportingBands: 3,
            postSupportingBands: 5,
          };
    },
  });

  beginShifted(runtime, 100);
  const firstRequest = runtime.requestBackingBoundary(3)!;
  assert.equal(runtime.acceptBackingBoundary({
    requestId: firstRequest.requestId,
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
  }, 110);
  await nextTurn();
  await nextTurn();

  assert.equal(comparisons, 1);
  assert.equal(commitPlans.length, 0, 'pre evidence alone must not commit against a disagreeing fresh mapping');

  // A repeated compatible follower correction rebuilds transport-frontier state,
  // but must carry already-proven pre-seek evidence and its replay mapping.
  beginShifted(runtime, 120);
  const secondRequest = runtime.requestBackingBoundary(3)!;
  assert.equal(runtime.acceptBackingBoundary({
    requestId: secondRequest.requestId,
    generation: 3,
    firstSampleIndex: 100,
    currentBackingGeneration: 3,
    context,
  }), true);

  currentDeltaMs = 100;
  backingTotalSamples = 200;
  runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 100,
    sourceSampleCount: 100,
    sourceSampleRate: 1_000,
    samples: new Int16Array(100).fill(8),
    start: 100,
    backingTotalSamples: 200,
  }, 130);
  await nextTurn();
  await nextTurn();

  assert.equal(comparisons, 2);
  assert.equal(commitPlans.length, 1);
  const plan = commitPlans[0];
  assert.ok(plan);
  assert.equal(plan.boundarySample, 100);
  assert.equal(plan.discardWorkingEvidence, false);
  assert.equal(plan.confirmedPreChunks.length, 1);
  assert.equal(plan.confirmedPreChunks[0].start, 100, '600 ms pre-delta vs 500 ms reference must preserve the +100 sample replay shift');
  assert.equal(plan.confirmedPreChunks[0].samples.length, 100);
  assert.equal(plan.postChunks.length, 1);
  assert.equal(plan.postChunks[0].start, 100);
  assert.equal(plan.postChunks[0].samples.length, 100);
  assert.equal(runtime.status(140).state, 'idle');
});

test('repeated compare-worker failure degrades fail-closed without committing mapping authority', async () => {
  let commitCalls = 0;
  let degradedReason: string | null = null;
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
      currentDeltaMs: () => 0,
      backingTotalSamples: () => 2_000,
      micTotalSamples: () => 2_000,
      readBacking: (_start, length) => new Int16Array(length).fill(10),
      readMic: (_start, length) => new Int16Array(length).fill(10),
      transitionEvidence: () => null,
      commit: () => {
        commitCalls += 1;
        return true;
      },
      onDegraded: (status) => {
        degradedReason = status.degradedReason;
      },
    },
    compareHypotheses: async () => {
      throw new Error('synthetic compare failure');
    },
  });

  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
  }, 100);
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
    sourceSampleCount: 300,
    sourceSampleRate: 1_000,
    samples: new Int16Array(300).fill(7),
    start: 0,
    backingTotalSamples: 300,
  }, 110);
  await nextTurn();
  await nextTurn();
  await nextTurn();

  const degraded = runtime.status(130);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.quarantined, true);
  assert.ok('workerFailures' in degraded);
  assert.ok('degradedReason' in degraded);
  assert.equal(degraded.workerFailures, 2);
  assert.equal(degraded.degradedReason, 'worker-failures');
  assert.equal(degradedReason, 'worker-failures');
  assert.equal(commitCalls, 0, 'worker failure must never grant mapping authority');
  assert.equal(runtime.requestBackingBoundary(3), null, 'terminal degradation cannot reacquire transport evidence');

  runtime.begin({
    fromMediaTime: 101,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context,
    confirmedReferenceLagMs: 750,
  }, 200);
  const fresh = runtime.status(200);
  assert.equal(fresh.state, 'verifying');
  assert.ok('workerFailures' in fresh);
  assert.equal(fresh.workerFailures, 0, 'a later concrete correction gets a fresh bounded failure budget');
});
