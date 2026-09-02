import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRobotActivationCoordinator } from '../src/relay-robot-activation-coordinator.js';

function fixture(active = true) {
  const events: string[] = [];
  const coordinator = createRelayRobotActivationCoordinator<string>({
    notifyPreviousReplaced: (previous) => events.push(`notify:${previous}`),
    noteQualityEvent: (event) => events.push(`quality:${event}`),
    abandonProbeRun: () => events.push('abandon-probe'),
    sessionActive: () => {
      events.push(`session-active:${active}`);
      return active;
    },
    resetPlayerOffset: () => events.push('reset-player-offset'),
    resetContentTimeline: () => events.push('reset-content-timeline'),
    clearBackingBoundaryRequest: () => events.push('clear-backing-boundary'),
    dropLegacyCalibrationForRobot: () => events.push('drop-legacy-calibration'),
    syncAppliedCalibration: () => events.push('sync-calibration'),
    reportSourceStatus: () => events.push('source-status'),
    reportTimingStatus: () => events.push('timing-status'),
  });
  return { coordinator, events };
}

test('Robot replacement retires old source evidence before resetting dependent timing state', () => {
  const { coordinator, events } = fixture(true);

  coordinator.activate({ previous: 'old', replaced: true });

  assert.deepEqual(events, [
    'notify:old',
    'quality:robot-source-replaced',
    'abandon-probe',
    'reset-player-offset',
    'reset-content-timeline',
    'clear-backing-boundary',
    'drop-legacy-calibration',
    'sync-calibration',
    'source-status',
    'timing-status',
  ]);
});

test('first Robot source records connection quality before resetting dependent timing state', () => {
  const { coordinator, events } = fixture(true);

  coordinator.activate({ previous: null, replaced: false });

  assert.deepEqual(events, [
    'session-active:true',
    'quality:robot-source-connected',
    'reset-player-offset',
    'reset-content-timeline',
    'clear-backing-boundary',
    'drop-legacy-calibration',
    'sync-calibration',
    'source-status',
    'timing-status',
  ]);
});

test('first Robot source outside an active session does not fabricate connection quality', () => {
  const { coordinator, events } = fixture(false);

  coordinator.activate({ previous: null, replaced: false });

  assert.equal(events.includes('quality:robot-source-connected'), false);
  assert.deepEqual(events.slice(0, 3), [
    'session-active:false',
    'reset-player-offset',
    'reset-content-timeline',
  ]);
});
