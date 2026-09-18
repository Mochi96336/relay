import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayRobotContentMappingRevocationCoordinator } from '../src/relay-robot-content-mapping-revocation-coordinator.js';

test('Robot content mapping revocation preserves teardown before publication', () => {
  const events: string[] = [];
  const coordinator = createRelayRobotContentMappingRevocationCoordinator({
    resetPlayerOffset: () => events.push('reset-player-offset'),
    resetContentTimeline: () => events.push('reset-content-timeline'),
    clearContentTransition: () => events.push('clear-content-transition'),
    invalidateSourceMapping: () => events.push('invalidate-source-mapping'),
    discardPrimedContent: () => events.push('discard-primed-content'),
    clearContentValidation: () => events.push('clear-content-validation'),
    abortCalibrationIfCollecting: (reason) => events.push(`abort-calibration:${reason}`),
    syncAppliedCalibration: () => events.push('sync-applied-calibration'),
    reportSourceStatus: () => events.push('source-status'),
    reportTimingStatus: () => events.push('timing-status'),
  });

  coordinator.revoke('Robot mapping invalidated.');

  assert.deepEqual(events, [
    'reset-player-offset',
    'reset-content-timeline',
    'clear-content-transition',
    'invalidate-source-mapping',
    'discard-primed-content',
    'clear-content-validation',
    'abort-calibration:Robot mapping invalidated.',
    'sync-applied-calibration',
    'source-status',
    'timing-status',
  ]);
});
