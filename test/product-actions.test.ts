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

function model(
  readinessInput: ReadinessInput,
  takeLifecycle: 'idle' | 'recording' = 'idle',
  calibrationActive = false,
  robotProbeTimingActive = true,
) {
  return buildProductViewModel({
    readiness: buildReadiness(readinessInput),
    participantCount: 1,
    micOwnerId: 'participant-alice',
    micOwnerNickname: 'Alice',
    publisherControlConnected: true,
    roomSong: {
      videoId: 'abcdefghijk',
      connected: true,
      clockAgeMs: 0,
      state: readinessInput.timelineState ?? null,
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
      calibrationActive,
      calibrationStale: false,
      alignmentClamped: false,
      requiresRobotPlayerDelta: robotProbeTimingActive,
      robotProbeTimingActive,
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
  assert.equal(status.actions.startTakeBlockedReason, 'room-blocked');
  assert.equal(status.actions.startTakeBlockingIssue?.code, 'robot-audio-unavailable');
  assert.equal(status.actions.startTakeBlockingIssue?.cause, 'backing-stalled');
});

test('a blocked Song keeps its concrete ProductIssue even before the mix becomes active', () => {
  const status = model({
    ...READY,
    backingConnected: false,
    backingStreaming: false,
    backingIsRobot: false,
    sessionActive: false,
  });

  assert.equal(status.health, 'blocked');
  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'room-blocked');
  assert.equal(status.actions.startTakeBlockingIssue?.cause, 'backing-not-ready');
});

test('active calibration disables Start Take even though calibration is normal preparation', () => {
  const status = model(READY, 'idle', true);

  assert.equal(status.lifecycle, 'preparing');
  assert.equal(status.health, 'healthy');
  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.startTakeBlockedReason, 'timing-calibration-active');
  assert.equal(status.actions.startTakeBlockingIssue, null);
  assert.equal(status.actions.canStartCalibration, false);
  assert.equal(status.actions.startCalibrationBlockedReason, 'calibration-active');
  assert.equal(status.actions.startCalibrationMode, 'boot-probe');
});

test('an active Take remains stoppable even if Robot health becomes blocked', () => {
  const status = model({ ...READY, backingStreaming: false }, 'recording');

  assert.equal(status.lifecycle, 'recording');
  assert.equal(status.health, 'blocked');
  assert.equal(status.actions.canStartTake, false);
  assert.equal(status.actions.canStopTake, true);
  assert.equal(status.actions.canStartCalibration, false);
  assert.equal(status.actions.startCalibrationBlockedReason, 'take-active');
  assert.equal(status.actions.startCalibrationMode, 'boot-probe');
});

test('Robot boot-probe stays startable with fresh capture when YouTube is not playing', () => {
  const status = model({ ...READY, timelineState: 2 });

  assert.equal(status.actions.canStartCalibration, true);
  assert.equal(status.actions.startCalibrationBlockedReason, null);
  assert.equal(status.actions.startCalibrationMode, 'boot-probe');
});

test('Robot boot-probe stays startable when the phone timeline is disconnected', () => {
  const status = model({
    ...READY,
    timelineConnected: false,
    timelineState: null,
  });

  assert.equal(status.actions.canStartCalibration, true);
  assert.equal(status.actions.startCalibrationBlockedReason, null);
  assert.equal(status.actions.startCalibrationMode, 'boot-probe');
});

test('Robot capture freshness blocks without becoming phone-not-playing', () => {
  for (const input of [
    { ...READY, micStreaming: false },
    { ...READY, backingStreaming: false },
  ]) {
    const status = model(input);
    assert.equal(status.actions.canStartCalibration, false);
    assert.equal(status.actions.startCalibrationBlockedReason, 'sources-not-streaming');
    assert.notEqual(status.actions.startCalibrationBlockedReason, 'phone-not-playing');
    assert.equal(status.actions.startCalibrationMode, 'boot-probe');
  }
});

test('content mode alone maps non-playing timeline to phone-not-playing', () => {
  const status = model({ ...READY, timelineState: 2 }, 'idle', false, false);

  assert.equal(status.actions.canStartCalibration, false);
  assert.equal(status.actions.startCalibrationBlockedReason, 'phone-not-playing');
  assert.equal(status.actions.startCalibrationMode, 'content');
});
