import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRobotDisconnectCoordinator } from '../src/relay-robot-disconnect-coordinator.js';

test('inactive socket is ignored without running Robot disconnect effects', () => {
  const socket = { id: 'other' };
  const calls: string[] = [];
  const coordinator = createRelayRobotDisconnectCoordinator<typeof socket>({
    isActive: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('isActive');
      return false;
    },
    noteDisconnected: () => calls.push('noteDisconnected'),
    detach: () => calls.push('detach'),
    resetPlayerOffset: () => calls.push('resetPlayerOffset'),
    resetContentTimeline: () => calls.push('resetContentTimeline'),
    clearBackingBoundaryRequest: () => calls.push('clearBackingBoundaryRequest'),
    abandonProbeRun: () => calls.push('abandonProbeRun'),
    failCalibrationIfCollecting: () => calls.push('failCalibrationIfCollecting'),
    syncAppliedCalibration: () => calls.push('syncAppliedCalibration'),
    reportSourceStatus: () => calls.push('reportSourceStatus'),
    reportTimingStatus: () => calls.push('reportTimingStatus'),
  });

  assert.equal(coordinator.handle(socket), false);
  assert.deepEqual(calls, ['isActive']);
});

test('active Robot disconnect preserves the server-owned effect order', () => {
  const socket = { id: 'robot' };
  const calls: string[] = [];
  const coordinator = createRelayRobotDisconnectCoordinator<typeof socket>({
    isActive: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('isActive');
      return true;
    },
    noteDisconnected: () => calls.push('noteDisconnected'),
    detach: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('detach');
    },
    resetPlayerOffset: () => calls.push('resetPlayerOffset'),
    resetContentTimeline: () => calls.push('resetContentTimeline'),
    clearBackingBoundaryRequest: () => calls.push('clearBackingBoundaryRequest'),
    abandonProbeRun: () => calls.push('abandonProbeRun'),
    failCalibrationIfCollecting: () => calls.push('failCalibrationIfCollecting'),
    syncAppliedCalibration: () => calls.push('syncAppliedCalibration'),
    reportSourceStatus: () => calls.push('reportSourceStatus'),
    reportTimingStatus: () => calls.push('reportTimingStatus'),
  });

  assert.equal(coordinator.handle(socket), true);
  assert.deepEqual(calls, [
    'isActive',
    'noteDisconnected',
    'detach',
    'resetPlayerOffset',
    'resetContentTimeline',
    'clearBackingBoundaryRequest',
    'abandonProbeRun',
    'failCalibrationIfCollecting',
    'syncAppliedCalibration',
    'reportSourceStatus',
    'reportTimingStatus',
  ]);
});
