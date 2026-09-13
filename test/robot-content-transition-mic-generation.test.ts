import assert from 'node:assert/strict';
import test from 'node:test';

import type { RobotContentTransitionComparison } from '../src/robot-content-transition.js';
import {
  RobotContentTransitionRuntime,
  type RobotContentTransitionContext,
} from '../src/robot-content-transition-runtime.js';

function nextTurn() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

test('Mic generation progress retires quarantined transition and aborts its worker', async () => {
  let liveContext: RobotContentTransitionContext = {
    sessionGeneration: 1,
    micGeneration: 2,
    backingGeneration: 3,
    sourceGeneration: 4,
  };
  const transitionContext = { ...liveContext };
  let compareSignal: AbortSignal | undefined;
  let resolveCompare: ((value: RobotContentTransitionComparison) => void) | null = null;
  const comparePromise = new Promise<RobotContentTransitionComparison>((resolve) => {
    resolveCompare = resolve;
  });
  let commitCalls = 0;

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
      context: () => ({ ...liveContext }),
      currentDeltaMs: () => 0,
      backingTotalSamples: () => 100,
      micTotalSamples: () => 2_000,
      readBacking: (_start, length) => new Int16Array(length).fill(10),
      readMic: (_start, length) => new Int16Array(length).fill(10),
      readBackingEvidence: () => ({ gapSamples: 0, frontierMissingSamples: 0 }),
      readMicEvidence: () => ({ gapSamples: 0, frontierMissingSamples: 0 }),
      transitionEvidence: () => null,
      commit: () => {
        commitCalls += 1;
        return true;
      },
    },
    compareHypotheses: async (_backing, _preMic, _postMic, _rate, signal) => {
      compareSignal = signal;
      return comparePromise;
    },
  });

  runtime.begin({
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 500,
    context: transitionContext,
    confirmedReferenceLagMs: 750,
    playbackRate: 1,
  }, 100);
  const request = runtime.requestBackingBoundary(3)!;
  assert.equal(runtime.acceptBackingBoundary({
    requestId: request.requestId,
    generation: 3,
    firstSampleIndex: 0,
    currentBackingGeneration: 3,
    context: transitionContext,
  }), true);
  assert.equal(runtime.noteBackingFrame({
    frameGeneration: 3,
    firstSampleIndex: 0,
    sourceSampleCount: 100,
    sourceSampleRate: 1_000,
    samples: new Int16Array(100).fill(7),
    start: 0,
    backingTotalSamples: 100,
  }, 120), true);

  assert.ok(compareSignal, 'the transition worker must be running before the capture changes');
  assert.equal(compareSignal!.aborted, false);
  assert.equal(runtime.status(120).state, 'verifying');
  assert.equal(runtime.quarantined, true);

  liveContext = { ...liveContext, micGeneration: 5 };
  runtime.noteMicProgress(130);

  assert.equal(compareSignal!.aborted, true, 'retiring the old capture must abort its worker');
  assert.equal(runtime.status(130).state, 'idle');
  assert.equal(runtime.quarantined, false);

  resolveCompare!({
    verdict: 'post',
    preScore: 0.1,
    postScore: 0.9,
    preSupportingBands: 3,
    postSupportingBands: 5,
  });
  await nextTurn();
  await nextTurn();

  assert.equal(commitCalls, 0, 'late old-generation completion must never commit content');
  assert.equal(runtime.status(140).state, 'idle');
});
