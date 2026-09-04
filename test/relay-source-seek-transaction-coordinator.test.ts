import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelaySourceSeekTransactionCoordinator } from '../src/relay-source-seek-transaction-coordinator.js';

type Context = { sessionGeneration: number };

function coordinator(calls: string[]) {
  return createRelaySourceSeekTransactionCoordinator<Context>({
    resetPlayerOffset: () => calls.push('reset-player-offset'),
    beginContentTransition: (from, to, pre, reference, context, nowMs) => {
      calls.push(`begin:${from}:${to}:${pre}:${reference}:${context.sessionGeneration}:${nowMs}`);
    },
    syncAppliedCalibration: () => calls.push('sync-calibration'),
    reportSourceStatus: () => calls.push('source-status'),
    reportTimingStatus: () => calls.push('timing-status'),
    revokeContentMapping: (reason) => calls.push(`revoke:${reason}`),
  });
}

test('mapped follower correction preserves transition then calibration publication ordering', () => {
  const calls: string[] = [];
  coordinator(calls).handle({
    mappedFollowerCorrection: true,
    fromMediaTime: 100.5,
    toMediaTime: 100,
    preDeltaMs: 500,
    referenceDeltaMs: 0,
    context: { sessionGeneration: 4 },
    nowMs: 120,
  });

  assert.deepEqual(calls, [
    'reset-player-offset',
    'begin:100.5:100:500:0:4:120',
    'sync-calibration',
    'source-status',
    'timing-status',
  ]);
});

test('mapped follower correction without complete deltas skips transition but still rebases', () => {
  const calls: string[] = [];
  coordinator(calls).handle({
    mappedFollowerCorrection: true,
    fromMediaTime: 2,
    toMediaTime: 1,
    preDeltaMs: null,
    referenceDeltaMs: 0,
    context: { sessionGeneration: 1 },
    nowMs: 20,
  });
  assert.deepEqual(calls, [
    'reset-player-offset',
    'sync-calibration',
    'source-status',
    'timing-status',
  ]);
});

test('destructive seek delegates the whole teardown to the shared revocation', () => {
  // A destructive seek *is* a Robot mapping revocation. Re-spelling its steps
  // here is how the teardown drifted into seven different subsets in the first
  // place, so this seam must own ordering only: reset the tracker the runtimes
  // already classified against, then hand the transaction over intact.
  const calls: string[] = [];
  coordinator(calls).handle({
    mappedFollowerCorrection: false,
    fromMediaTime: Number.NaN,
    toMediaTime: Number.NaN,
    preDeltaMs: null,
    referenceDeltaMs: null,
    context: { sessionGeneration: 2 },
    nowMs: 30,
  });
  assert.deepEqual(calls, [
    'reset-player-offset',
    'revoke:The desktop player seeked during calibration. Start calibration again.',
  ]);
});
