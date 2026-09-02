import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayManualBootRecalibrationCoordinator } from '../src/relay-manual-boot-recalibration-coordinator.js';

test('manual Robot recalibration preserves exact candidate transaction ordering', () => {
  const calls: string[] = [];
  const coordinator = createRelayManualBootRecalibrationCoordinator({
    clearContentValidation: () => calls.push('clear-content-validation'),
    beginExternalRecalibration: () => calls.push('begin-external-recalibration'),
    beginManualBootProbe: () => calls.push('begin-manual-boot-probe'),
    abandonProbeRun: () => calls.push('abandon-probe-run'),
    resetProbeCorrelations: () => calls.push('reset-probe-correlations'),
    syncAppliedCalibration: () => calls.push('sync-applied-calibration'),
    maybeStartProbeCalibration: (nowMs) => calls.push(`start-probe:${nowMs}`),
    reportTimingStatus: () => calls.push('timing-status'),
    reportSourceStatus: () => calls.push('source-status'),
  });

  coordinator.restart(1234);

  assert.deepEqual(calls, [
    'clear-content-validation',
    'begin-external-recalibration',
    'begin-manual-boot-probe',
    'abandon-probe-run',
    'reset-probe-correlations',
    'sync-applied-calibration',
    'start-probe:1234',
    'timing-status',
    'source-status',
  ]);
});
