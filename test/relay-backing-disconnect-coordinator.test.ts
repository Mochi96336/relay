import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayBackingDisconnectCoordinator } from '../src/relay-backing-disconnect-coordinator.js';

test('non-backing close is ignored without Backing disconnect effects', () => {
  const socket = { id: 'other' };
  const calls: string[] = [];
  const coordinator = createRelayBackingDisconnectCoordinator<typeof socket>({
    isBacking: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('isBacking');
      return false;
    },
    noteDisconnected: () => calls.push('noteDisconnected'),
    clearRobotBackingBoundaryRequest: () => calls.push('clearRobotBackingBoundaryRequest'),
    detach: () => calls.push('detach'),
    clearBackingExpectation: () => calls.push('clearBackingExpectation'),
    failCalibrationIfCollecting: () => calls.push('failCalibrationIfCollecting'),
    cancelContentValidationAndReport: () => calls.push('cancelContentValidationAndReport'),
    reportSourceStatus: () => calls.push('reportSourceStatus'),
    reportStatus: () => calls.push('reportStatus'),
  });

  assert.equal(coordinator.handle(socket), false);
  assert.deepEqual(calls, ['isBacking']);
});

test('active Backing disconnect preserves server-owned effect order', () => {
  const socket = { id: 'backing' };
  const calls: string[] = [];
  const coordinator = createRelayBackingDisconnectCoordinator<typeof socket>({
    isBacking: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('isBacking');
      return true;
    },
    noteDisconnected: () => calls.push('noteDisconnected'),
    clearRobotBackingBoundaryRequest: () => calls.push('clearRobotBackingBoundaryRequest'),
    detach: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('detach');
    },
    clearBackingExpectation: () => calls.push('clearBackingExpectation'),
    failCalibrationIfCollecting: () => calls.push('failCalibrationIfCollecting'),
    cancelContentValidationAndReport: () => calls.push('cancelContentValidationAndReport'),
    reportSourceStatus: () => calls.push('reportSourceStatus'),
    reportStatus: () => calls.push('reportStatus'),
  });

  assert.equal(coordinator.handle(socket), true);
  assert.deepEqual(calls, [
    'isBacking',
    'noteDisconnected',
    'clearRobotBackingBoundaryRequest',
    'detach',
    'clearBackingExpectation',
    'failCalibrationIfCollecting',
    'cancelContentValidationAndReport',
    'reportSourceStatus',
    'reportStatus',
  ]);
});
