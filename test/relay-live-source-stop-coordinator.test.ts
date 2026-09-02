import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayLiveSourceStopCoordinator } from '../src/relay-live-source-stop-coordinator.js';

function coordinatorFor(events: string[], active: boolean) {
  return createRelayLiveSourceStopCoordinator({
    cancelBackingGrace: () => events.push('cancel-backing-grace'),
    retireRobotRoute: () => events.push('retire-robot-route'),
    sessionActive: () => {
      events.push('session-active');
      return active;
    },
    endTakeMix: () => events.push('end-take-mix'),
    clearBootCalibration: () => events.push('clear-boot-calibration'),
    clearContentValidation: () => events.push('clear-content-validation'),
    resetRobotPlayerOffset: () => events.push('reset-player-offset'),
    resetRobotContentTimeline: () => events.push('reset-content-timeline'),
    clearRobotBackingBoundaryRequest: () => events.push('clear-backing-boundary'),
    stopSession: () => events.push('stop-session'),
    resetCalibration: () => events.push('reset-calibration'),
    clearTimingKind: () => events.push('clear-timing-kind'),
    resetAutoCalibrationSchedule: () => events.push('reset-auto-calibration-schedule'),
    reportTimingStatus: () => events.push('timing-status'),
    reportSourceStatus: () => events.push('source-status'),
    reportStatus: () => events.push('status'),
  });
}

test('active live source teardown preserves the full cross-domain ordering', () => {
  const events: string[] = [];
  const coordinator = coordinatorFor(events, true);

  assert.equal(coordinator.stop(), true);
  assert.deepEqual(events, [
    'cancel-backing-grace',
    'retire-robot-route',
    'session-active',
    'end-take-mix',
    'clear-boot-calibration',
    'clear-content-validation',
    'reset-player-offset',
    'reset-content-timeline',
    'clear-backing-boundary',
    'stop-session',
    'reset-calibration',
    'clear-timing-kind',
    'reset-auto-calibration-schedule',
    'timing-status',
    'source-status',
    'status',
  ]);
});

test('inactive live source still clears backing grace and Robot-route state', () => {
  const events: string[] = [];
  const coordinator = coordinatorFor(events, false);

  assert.equal(coordinator.stop(), false);
  assert.deepEqual(events, [
    'cancel-backing-grace',
    'retire-robot-route',
    'session-active',
  ]);
});
