import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayMicTimingInvalidationCoordinator } from '../src/relay-mic-timing-invalidation-coordinator.js';

function harness() {
  const events: string[] = [];
  const coordinator = createRelayMicTimingInvalidationCoordinator({
    clearBootCalibration: () => events.push('clear-boot-calibration'),
    clearContentValidation: () => events.push('clear-content-validation'),
    invalidateCalibration: (message) => events.push(`invalidate-calibration:${message}`),
    clearTimingKind: () => events.push('clear-timing-kind'),
    resetAutoCalibrationSchedule: () => events.push('reset-auto-calibration-schedule'),
    syncAppliedCalibration: () => events.push('sync-applied-calibration'),
    reportTimingStatus: () => events.push('timing-status'),
    reportSourceStatus: () => events.push('source-status'),
  });
  return { coordinator, events };
}

test('Mic ownership timing invalidation preserves destructive teardown before publication', () => {
  const { coordinator, events } = harness();

  coordinator.invalidate('Microphone ownership changed.');

  assert.deepEqual(events, [
    'clear-boot-calibration',
    'clear-content-validation',
    'invalidate-calibration:Microphone ownership changed.',
    'clear-timing-kind',
    'reset-auto-calibration-schedule',
    'sync-applied-calibration',
    'timing-status',
    'source-status',
  ]);
});

test('Mic capture replacement preserves confirmed calibration history while revoking live authority', () => {
  const { coordinator, events } = harness();

  coordinator.invalidate('Microphone capture changed.');

  assert.deepEqual(events, [
    'clear-boot-calibration',
    'clear-content-validation',
    'sync-applied-calibration',
    'timing-status',
    'source-status',
  ]);
  assert.equal(
    events.some((event) => event.startsWith('invalidate-calibration:')),
    false,
    'capture replacement must keep the confirmed measurement as stale history',
  );
  assert.equal(events.includes('clear-timing-kind'), false);
  assert.equal(events.includes('reset-auto-calibration-schedule'), false);
});
