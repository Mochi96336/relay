import assert from 'node:assert/strict';
import test from 'node:test';

import { buildProductViewModel } from '../src/product-view-model.js';
import { buildReadiness, type ReadinessInput } from '../src/readiness.js';

const BASE: ReadinessInput = {
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
  timelineConnected: false,
  timelineState: null,
  playerOffsetMs: null,
  playerOffsetFresh: false,
  calibrationState: 'idle',
  calibrationValid: false,
  calibrationStale: false,
  calibrationKind: 'none',
  probeCorrelation: { mic: null, backing: null },
  bootCalibration: null,
};

function status(readinessInput: ReadinessInput) {
  return buildProductViewModel({
    readiness: buildReadiness(readinessInput),
    participantCount: 1,
    micOwnerId: 'participant-a',
    micOwnerNickname: 'A',
    publisherControlConnected: true,
    roomSong: {
      videoId: null,
      connected: false,
      clockAgeMs: 0,
      state: null,
      handoffState: 'idle',
    },
    take: { lifecycle: 'idle', takeId: null, qualityVerdict: null },
    timing: {
      timingMode: 'network-estimate',
      calibrationState: 'idle',
      calibrationActive: false,
      calibrationStale: false,
      alignmentClamped: false,
      requiresRobotPlayerDelta: true,
      robotProbeTimingActive: true,
      robotDeltaFresh: false,
    },
  });
}

test('no-Song Robot preflight remains calibration-actionable when both probe legs are ready', () => {
  const product = status(BASE);
  assert.equal(product.room.song.state, 'empty');
  assert.equal(product.actions.startCalibrationMode, 'boot-probe');
  assert.equal(product.actions.canStartCalibration, true);
  assert.equal(product.actions.startCalibrationBlockedReason, null);
});

test('Robot backing without Robot source does not advertise a boot probe that will wait forever', () => {
  const product = status({ ...BASE, robotSourceConnected: false });
  assert.equal(product.actions.startCalibrationMode, 'boot-probe');
  assert.equal(product.actions.canStartCalibration, false);
  assert.equal(product.actions.startCalibrationBlockedReason, 'sources-not-connected');
});

test('Robot source with a non-Robot backing cannot advertise boot-probe calibration', () => {
  const product = status({ ...BASE, backingIsRobot: false });
  assert.equal(product.actions.startCalibrationMode, 'boot-probe');
  assert.equal(product.actions.canStartCalibration, false);
  assert.equal(product.actions.startCalibrationBlockedReason, 'sources-not-connected');
});
