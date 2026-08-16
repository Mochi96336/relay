import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildReadiness, type ReadinessInput } from '../src/readiness.js';

const BASE: ReadinessInput = {
  backingConnected: true,
  backingStreaming: true,
  backingSampleRate: 48_000,
  backingIsRobot: true,
  micConnected: true,
  micStreaming: true,
  robotSourceConnected: true,
  sessionActive: true,
  timelineConnected: true,
  timelineState: 1,
  playerOffsetMs: 10,
  playerOffsetFresh: true,
  calibrationState: 'complete',
  calibrationValid: true,
  calibrationStale: false,
  calibrationKind: 'boot-probe',
  probeCorrelation: { mic: 0.8, backing: 0.9 },
  bootCalibration: { advanceMs: 20 },
};

describe('technical readiness boundary', () => {
  test('separates host readiness from full session readiness', () => {
    const result = buildReadiness({
      ...BASE,
      micConnected: false,
      micStreaming: false,
      timelineConnected: false,
      timelineState: null,
      playerOffsetFresh: false,
      calibrationState: 'idle',
      calibrationValid: false,
    });

    assert.equal(result.ready, true);
    assert.equal(result.sessionReady, false);
    assert.deepEqual(result.reasons, []);
    assert.ok(result.sessionReasons.includes('mic-not-connected'));
    assert.ok(result.sessionReasons.includes('phone-timeline-not-connected'));
    assert.ok(result.sessionReasons.includes('calibration-missing'));
  });

  test('requires the formal robot route for host readiness', () => {
    const result = buildReadiness({ ...BASE, backingIsRobot: false });
    assert.equal(result.ready, false);
    assert.ok(result.reasons.includes('backing-not-robot'));
  });

  test('withdraws full session readiness when the robot player delta is stale', () => {
    const result = buildReadiness({ ...BASE, playerOffsetFresh: false });
    assert.equal(result.ready, true);
    assert.equal(result.sessionReady, false);
    assert.ok(result.sessionReasons.includes('robot-player-offset-stale'));
  });
});
