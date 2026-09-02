import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelaySourceSeekTransactionCoordinator } from '../src/relay-source-seek-transaction-coordinator.js';

type Context = { sessionGeneration: number };

function coordinator(calls: string[], collecting = false) {
  return createRelaySourceSeekTransactionCoordinator<Context>({
    resetPlayerOffset: () => calls.push('reset-player-offset'),
    beginContentTransition: (from, to, pre, reference, context, nowMs) => {
      calls.push(`begin:${from}:${to}:${pre}:${reference}:${context.sessionGeneration}:${nowMs}`);
    },
    syncAppliedCalibration: () => calls.push('sync-calibration'),
    reportSourceStatus: () => calls.push('source-status'),
    reportTimingStatus: () => calls.push('timing-status'),
    clearContentTransition: () => calls.push('clear-transition'),
    invalidateSourceMapping: () => calls.push('invalidate-mapping'),
    clearContentValidation: () => calls.push('clear-validation'),
    discardPrimedContent: () => calls.push('discard-primed'),
    resetContentTimeline: () => calls.push('reset-content-timeline'),
    calibrationCollecting: () => {
      calls.push('calibration-collecting');
      return collecting;
    },
    failCalibration: (message) => calls.push(`fail:${message}`),
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

test('destructive seek clears mapping evidence before rebasing and publishing', () => {
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
    'clear-transition',
    'invalidate-mapping',
    'clear-validation',
    'discard-primed',
    'reset-content-timeline',
    'calibration-collecting',
    'sync-calibration',
    'source-status',
    'timing-status',
  ]);
});

test('destructive seek during calibration fails after cleanup without duplicate publication', () => {
  const calls: string[] = [];
  coordinator(calls, true).handle({
    mappedFollowerCorrection: false,
    fromMediaTime: 5,
    toMediaTime: 9,
    preDeltaMs: 1,
    referenceDeltaMs: 2,
    context: { sessionGeneration: 3 },
    nowMs: 40,
  });
  assert.deepEqual(calls, [
    'reset-player-offset',
    'clear-transition',
    'invalidate-mapping',
    'clear-validation',
    'discard-primed',
    'reset-content-timeline',
    'calibration-collecting',
    'fail:The desktop player seeked during calibration. Start calibration again.',
  ]);
});
