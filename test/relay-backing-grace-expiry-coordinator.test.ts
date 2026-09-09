import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayBackingGraceExpiryCoordinator } from '../src/relay-backing-grace-expiry-coordinator.js';

function coordinatorFor(events: string[]) {
  return createRelayBackingGraceExpiryCoordinator({
    stopLiveSource: () => events.push('stop-live-source'),
    retireRobotRoute: () => events.push('retire-robot-route'),
    clearRobotBackingBoundaryRequest: () => events.push('clear-robot-backing-boundary'),
    invalidateMicTiming: (message) => events.push(`invalidate-mic-timing:${message}`),
    reportStatus: () => events.push('status'),
  });
}

test('expired Backing grace stops the live source when Song still exists', () => {
  const events: string[] = [];
  const outcome = coordinatorFor(events).expire({ roomHasSong: true, micArmed: true });

  assert.equal(outcome, 'stopped');
  assert.deepEqual(events, ['stop-live-source']);
});

test('expired Backing grace stops the live source when Mic is no longer armed', () => {
  const events: string[] = [];
  const outcome = coordinatorFor(events).expire({ roomHasSong: false, micArmed: false });

  assert.equal(outcome, 'stopped');
  assert.deepEqual(events, ['stop-live-source']);
});

test('expired Backing grace downgrades an armed Mic room to voice-only in one ordered transaction', () => {
  const events: string[] = [];
  const outcome = coordinatorFor(events).expire({ roomHasSong: false, micArmed: true });

  assert.equal(outcome, 'voice-only');
  assert.deepEqual(events, [
    'retire-robot-route',
    'clear-robot-backing-boundary',
    'invalidate-mic-timing:Backing route ended while the room continued voice-only.',
    'status',
  ]);
});
