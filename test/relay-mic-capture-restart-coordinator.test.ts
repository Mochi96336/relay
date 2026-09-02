import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayMicCaptureRestartCoordinator } from '../src/relay-mic-capture-restart-coordinator.js';

function coordinatorFor(calls: string[]) {
  return createRelayMicCaptureRestartCoordinator({
    noteQualityEvent: (event) => calls.push(`quality:${event}`),
    abandonProbeRun: () => calls.push('abandon-probe'),
    clearContentValidation: () => calls.push('clear-content-validation'),
    failCalibration: (message) => calls.push(`fail:${message}`),
    syncAppliedCalibration: () => calls.push('sync-applied-calibration'),
    reportTimingStatus: () => calls.push('timing-status'),
    reportSourceStatus: () => calls.push('source-status'),
  });
}

test('Mic capture restart publishes invalidated timing before source status when calibration is idle', () => {
  const calls: string[] = [];
  coordinatorFor(calls).restart({ calibrationCollecting: false });

  assert.deepEqual(calls, [
    'quality:mic-capture-restarted',
    'abandon-probe',
    'clear-content-validation',
    'sync-applied-calibration',
    'timing-status',
    'source-status',
  ]);
});

test('Mic capture restart lets active calibration failure own settled publication', () => {
  const calls: string[] = [];
  coordinatorFor(calls).restart({ calibrationCollecting: true });

  assert.deepEqual(calls, [
    'quality:mic-capture-restarted',
    'abandon-probe',
    'clear-content-validation',
    'fail:Microphone capture restarted during calibration. Start calibration again.',
  ]);
});
