import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createRelayRobotContentTransitionCommitCoordinator,
  type RelayRobotContentTransitionCommitPlan,
} from '../src/relay-robot-content-transition-commit-coordinator.js';

type Context = { sessionGeneration: number };

const preSamples = new Int16Array([1, 2]);
const postSamples = new Int16Array([3, 4]);

function plan(overrides: Partial<RelayRobotContentTransitionCommitPlan<Context>> = {}) {
  return {
    context: { sessionGeneration: 7 },
    boundarySample: 50,
    discardWorkingEvidence: false,
    confirmedPreChunks: [{ start: 10, samples: preSamples }],
    postChunks: [{ start: 20, samples: postSamples }, { start: 30, samples: postSamples }],
    ...overrides,
  };
}

function coordinator(calls: string[], options: { boundaryAccepted?: boolean; collecting?: boolean } = {}) {
  return createRelayRobotContentTransitionCommitCoordinator<Context>({
    noteBackingBoundary: (boundarySample, context, nowMs) => {
      calls.push('boundary:' + boundarySample + ':' + context.sessionGeneration + ':' + nowMs);
      return options.boundaryAccepted !== false;
    },
    restartWorkingEvidence: (nowMs) => calls.push('restart:' + nowMs),
    contentValidationCollecting: () => {
      calls.push('validation-collecting');
      return options.collecting === true;
    },
    cancelContentValidation: (nowMs) => calls.push('cancel-validation:' + nowMs),
    feedBackingEvidence: (samples, start, nowMs) => {
      calls.push('feed:' + start + ':' + Array.from(samples).join(',') + ':' + nowMs);
    },
    mapBackingStart: (start, context, nowMs) => {
      calls.push('map:' + start + ':' + context.sessionGeneration + ':' + nowMs);
      return start === 30 ? null : start + 100;
    },
  });
}

test('boundary rejection fails closed before any calibration or evidence effect', () => {
  const calls: string[] = [];
  const committed = coordinator(calls, { boundaryAccepted: false }).commit(plan(), 99);

  assert.equal(committed, false);
  assert.deepEqual(calls, ['boundary:50:7:99']);
});

test('accepted non-discard commit feeds confirmed pre evidence before mapped post evidence', () => {
  const calls: string[] = [];
  const committed = coordinator(calls).commit(plan(), 99);

  assert.equal(committed, true);
  assert.deepEqual(calls, [
    'boundary:50:7:99',
    'feed:10:1,2:99',
    'map:20:7:99',
    'feed:120:3,4:99',
    'map:30:7:99',
  ]);
});

test('discard commit resets working evidence and cancels active validation before evidence effects', () => {
  const calls: string[] = [];
  const committed = coordinator(calls, { collecting: true }).commit(plan({ discardWorkingEvidence: true }), 99);

  assert.equal(committed, true);
  assert.deepEqual(calls, [
    'boundary:50:7:99',
    'restart:99',
    'validation-collecting',
    'cancel-validation:99',
    'feed:10:1,2:99',
    'map:20:7:99',
    'feed:120:3,4:99',
    'map:30:7:99',
  ]);
});

test('discard commit observes inactive validation without inventing a cancellation', () => {
  const calls: string[] = [];
  coordinator(calls).commit(plan({
    discardWorkingEvidence: true,
    confirmedPreChunks: [],
    postChunks: [],
  }), 99);

  assert.deepEqual(calls, [
    'boundary:50:7:99',
    'restart:99',
    'validation-collecting',
  ]);
});
