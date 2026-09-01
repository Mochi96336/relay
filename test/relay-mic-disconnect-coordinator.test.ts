import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayMicDisconnectCoordinator } from '../src/relay-mic-disconnect-coordinator.js';

function coordinatorFor(socket: { id: string }, calls: string[], options: {
  publisher: boolean;
  reconnectingOwnerId: string | null;
}) {
  return createRelayMicDisconnectCoordinator<typeof socket>({
    isPublisher: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('isPublisher');
      return options.publisher;
    },
    noteDisconnected: () => calls.push('noteDisconnected'),
    reconnectingOwnerId: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('reconnectingOwnerId');
      return options.reconnectingOwnerId;
    },
    detachPublisher: (candidate) => {
      assert.equal(candidate, socket);
      calls.push('detachPublisher');
    },
    clearMediaAuthority: () => calls.push('clearMediaAuthority'),
    preserveMediaForReconnect: (ownerId) => calls.push(`preserveMediaForReconnect:${ownerId}`),
    maybeStopLiveSourceWhenUnarmed: () => calls.push('maybeStopLiveSourceWhenUnarmed'),
    failCalibrationIfCollecting: () => calls.push('failCalibrationIfCollecting'),
    cancelContentValidationAndReport: () => calls.push('cancelContentValidationAndReport'),
    reportStatus: () => calls.push('reportStatus'),
  });
}

test('non-publisher close is ignored without Mic disconnect effects', () => {
  const socket = { id: 'other' };
  const calls: string[] = [];
  const coordinator = coordinatorFor(socket, calls, {
    publisher: false,
    reconnectingOwnerId: null,
  });

  assert.equal(coordinator.handle(socket), false);
  assert.deepEqual(calls, ['isPublisher']);
});

test('publisher without reconnecting owner clears media before live-source cleanup', () => {
  const socket = { id: 'mic' };
  const calls: string[] = [];
  const coordinator = coordinatorFor(socket, calls, {
    publisher: true,
    reconnectingOwnerId: null,
  });

  assert.equal(coordinator.handle(socket), true);
  assert.deepEqual(calls, [
    'isPublisher',
    'noteDisconnected',
    'reconnectingOwnerId',
    'detachPublisher',
    'clearMediaAuthority',
    'maybeStopLiveSourceWhenUnarmed',
    'failCalibrationIfCollecting',
    'cancelContentValidationAndReport',
    'reportStatus',
  ]);
});

test('reconnecting owner preserves media authority through grace without stopping live source', () => {
  const socket = { id: 'mic' };
  const calls: string[] = [];
  const coordinator = coordinatorFor(socket, calls, {
    publisher: true,
    reconnectingOwnerId: 'participant-a',
  });

  assert.equal(coordinator.handle(socket), true);
  assert.deepEqual(calls, [
    'isPublisher',
    'noteDisconnected',
    'reconnectingOwnerId',
    'detachPublisher',
    'preserveMediaForReconnect:participant-a',
    'failCalibrationIfCollecting',
    'cancelContentValidationAndReport',
    'reportStatus',
  ]);
});
