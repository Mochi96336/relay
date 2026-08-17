import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  buildProductIssues,
  type ProductIssueFacts,
} from '../src/product-issues.js';
import { buildProductViewModel, type ProductViewModelInput } from '../src/product-view-model.js';
import { buildReadiness, type ReadinessInput } from '../src/readiness.js';

const HEALTHY_ISSUES: ProductIssueFacts = {
  routeMode: 'robot',
  backing: { connected: true, streaming: true, robot: true },
  robotSourceConnected: true,
  songClockSeverity: null,
  mic: { ownerId: 'participant-a', state: 'live' },
  takeLifecycle: 'idle',
  performanceActive: true,
  timingState: 'aligned',
};

const READY: ReadinessInput = {
  routeMode: 'robot',
  backingConnected: true,
  backingStreaming: true,
  backingSampleRate: 48_000,
  backingIsRobot: true,
  micConnected: true,
  micStreaming: true,
  micFlowObserved: true,
  robotSourceConnected: true,
  sessionActive: true,
  timelineConnected: true,
  timelineState: 1,
  playerOffsetMs: 12,
  playerOffsetFresh: true,
  calibrationState: 'complete',
  calibrationValid: true,
  calibrationStale: false,
  calibrationKind: 'boot-probe',
  probeCorrelation: { mic: 0.8, backing: 0.9 },
  bootCalibration: { advanceMs: 20 },
};

function productInput(readinessInput: ReadinessInput = READY): ProductViewModelInput {
  return {
    readiness: buildReadiness(readinessInput),
    participantCount: 1,
    micOwnerId: 'participant-a',
    micOwnerNickname: 'Alice',
    roomSong: {
      videoId: 'abcdefghijk',
      connected: true,
      clockAgeMs: 0,
      state: 1,
      handoffState: 'idle',
    },
    take: {
      lifecycle: 'idle',
      takeId: null,
      qualityVerdict: null,
    },
    timing: {
      timingMode: 'acoustic-calibration',
      calibrationState: 'complete',
      calibrationStale: false,
      alignmentClamped: false,
      requiresRobotPlayerDelta: true,
      robotDeltaFresh: true,
    },
  };
}

describe('product issue contract', () => {
  test('healthy product facts have no issues', () => {
    assert.deepEqual(buildProductIssues(HEALTHY_ISSUES), []);
  });

  test('keeps independent room failures instead of collapsing everything into one attention flag', () => {
    const issues = buildProductIssues({
      ...HEALTHY_ISSUES,
      backing: { connected: false, streaming: false, robot: false },
      robotSourceConnected: false,
    });

    assert.deepEqual(issues.map((issue) => issue.code), [
      'robot-audio-unavailable',
      'robot-player-unavailable',
    ]);
    assert.deepEqual(issues[0], {
      code: 'robot-audio-unavailable',
      scope: 'robot',
      severity: 'critical',
      cause: 'backing-disconnected',
      affects: ['song', 'recording'],
      recovery: 'host-service',
    });
    assert.equal(issues[1].cause, 'robot-source-disconnected');
  });

  test('describes cause, impact and recovery for concurrent user-visible warnings', () => {
    const issues = buildProductIssues({
      ...HEALTHY_ISSUES,
      mic: { ownerId: 'participant-a', state: 'interrupted' },
      takeLifecycle: 'failed',
      timingState: 'stale',
    });

    assert.deepEqual(issues.map((issue) => issue.code), [
      'mic-audio-stalled',
      'take-failed',
      'timing-recovering',
    ]);
    assert.deepEqual(issues[0].affects, ['voice', 'recording']);
    assert.equal(issues[0].recovery, 'retry-mic');
    assert.equal(issues[1].recovery, 'retry-recording');
    assert.equal(issues[2].cause, 'timing-stale');
    assert.equal(issues[2].recovery, 'recalibrate');
  });

  test('ProductStatus exposes all issues while attention remains the highest-priority compatibility item', () => {
    const model = buildProductViewModel(productInput({
      ...READY,
      backingConnected: false,
      backingStreaming: false,
      robotSourceConnected: false,
    }));

    assert.equal(model.health, 'blocked');
    assert.equal(model.issues.length, 2);
    assert.equal(model.attention, model.issues[0]);
    assert.equal(model.attention?.code, 'robot-audio-unavailable');
    assert.equal(model.issues[1].code, 'robot-player-unavailable');
  });
});
