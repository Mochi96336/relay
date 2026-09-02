import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayMicTimingInvalidationCoordinator } from '../src/relay-mic-timing-invalidation-coordinator.js';

test('Mic timing invalidation preserves calibration teardown before publication', () => {
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
