import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductViewModel } from '../src/product-view-model.js';
import { buildReadiness, type ReadinessInput } from '../src/readiness.js';

const READY: ReadinessInput = {
  backingConnected: true,
  backingStreaming: true,
  backingSampleRate: 48_000,
  backingIsRobot: true,
  micConnected: true,
  micStreaming: true,
  robotSourceConnected: true,
  sessionActive: true,
  timelineConnected: true,
  timelineState: 1,
  playerOffsetMs: 0,
  playerOffsetFresh: true,
  calibrationState: 'complete',
  calibrationValid: true,
  calibrationStale: false,
  calibrationKind: 'boot-probe',
  probeCorrelation: { mic: 0.8, backing: 0.9 },
  bootCalibration: { advanceMs: 0 },
};

function model(readinessInput: ReadinessInput, takeLifecycle: 'idle' | 'recording' = 'idle') {
  return buildProductViewModel({
    readiness: buildReadiness(readinessInput),
    participantCount: 1,
    micOwnerId: 'participant-alice',
    micOwnerNickname: 'Alice',
    roomSong: {
      videoId: 'abcdefghijk',
      connected: true,
      state: 1,
      handoffState: 'idle',
    },
    take: {
      lifecycle: takeLifecycle,
      takeId: takeLifecycle === 'recording' ? 'take-1' : null,
      qualityVerdict: null,
    },
    timing: {
      timingMode: 'acoustic-calibration',
      calibrationState: 'complete',
      calibrationStale: false,
      alignmentClamped: false,
      robotRoute: true,
      robotDeltaFresh: true,
    },
  });
}

test('a lingering active mix cannot start a new Take while Robot audio is blocked', () => {
  const status = model({
    ...READY,
    backingStreaming: false,
    // Backing grace can leave the AudioSession alive briefly after transport
    // health is already lost. Product actions must follow health, not that lag.
    sessionActive: true,
  });

  assert.equal(status.lifecycle, 'live');
  assert.equal(status.health, 'blocked');
  assert.equal(status.attention?.code, 'robot-audio-unavailable');
  assert.equal(status.actions.canStartTake, false);
});

test('an active Take remains stoppable even if Robot health becomes blocked', () => {
  const status = model({ ...READY, backingStreaming: false }, 'recording');

  assert.equal(status.lifecycle, 'recording');
  assert.equal(status.health, 'blocked');
  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.canStopTake, true);
});
