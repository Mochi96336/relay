import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayBackingCaptureRestartCoordinator } from '../src/relay-backing-capture-restart-coordinator.js';

function coordinatorFor(calls: string[]) {
  return createRelayBackingCaptureRestartCoordinator({
    clearBackingBoundaryRequest: () => calls.push('clear-boundary'),
    noteQualityEvent: (event) => calls.push(`quality:${event}`),
    abandonProbeRun: () => calls.push('abandon-probe'),
    clearContentValidation: () => calls.push('clear-content-validation'),
    failCalibration: (message) => calls.push(`fail:${message}`),
    syncAppliedCalibration: () => calls.push('sync-applied-calibration'),
    reportTimingStatus: () => calls.push('timing-status'),
    reportSourceStatus: () => calls.push('source-status'),
  });
}

test('Backing capture restart clears Robot boundary state before timing invalidation publication', () => {
  const calls: string[] = [];
  coordinatorFor(calls).restart({ calibrationCollecting: false });

  assert.deepEqual(calls, [
    'clear-boundary',
    'quality:backing-capture-restarted',
    'abandon-probe',
    'clear-content-validation',
    'sync-applied-calibration',
    'timing-status',
    'source-status',
  ]);
});

test('Backing capture restart lets active calibration failure own settled publication', () => {
  const calls: string[] = [];
  coordinatorFor(calls).restart({ calibrationCollecting: true });

  assert.deepEqual(calls, [
    'clear-boundary',
    'quality:backing-capture-restarted',
    'abandon-probe',
    'clear-content-validation',
    'fail:Backing capture restarted during calibration. Start calibration again.',
  ]);
});
