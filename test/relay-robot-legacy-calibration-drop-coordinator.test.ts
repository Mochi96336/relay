import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRobotLegacyCalibrationDropCoordinator } from '../src/relay-robot-legacy-calibration-drop-coordinator.js';

function fixture(options: {
  robotRouteActive?: boolean;
  calibrationKind?: 'none' | 'boot-probe' | 'content';
  bootProbeSettled?: boolean;
} = {}) {
  const events: string[] = [];
  const coordinator = createRelayRobotLegacyCalibrationDropCoordinator({
    robotRouteActive: () => options.robotRouteActive ?? true,
    calibrationKind: () => options.calibrationKind ?? 'content',
    bootProbeSettled: () => options.bootProbeSettled ?? false,
    clearContentValidationBaseline: () => events.push('clear-content-validation'),
    resetCalibration: () => events.push('reset-calibration'),
    clearCalibrationKind: () => events.push('clear-calibration-kind'),
    resetAutoCalibrationSchedule: () => events.push('reset-auto-schedule'),
    syncAppliedCalibration: () => events.push('sync-applied-calibration'),
  });
  return { coordinator, events };
}

test('legacy Robot content calibration drops through one ordered transaction before boot probe settles', () => {
  const { coordinator, events } = fixture();

  coordinator.drop();

  assert.deepEqual(events, [
    'clear-content-validation',
    'reset-calibration',
    'clear-calibration-kind',
    'reset-auto-schedule',
    'sync-applied-calibration',
  ]);
});

test('legacy calibration remains untouched outside the Robot content bootstrap window', () => {
  for (const options of [
    { robotRouteActive: false },
    { calibrationKind: 'boot-probe' as const },
    { calibrationKind: 'none' as const },
    { bootProbeSettled: true },
  ]) {
    const { coordinator, events } = fixture(options);
    coordinator.drop();
    assert.deepEqual(events, []);
  }
});
