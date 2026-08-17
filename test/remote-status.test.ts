import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildReadiness, type ReadinessInput } from '../src/readiness.js';
import { deriveRemoteStatusHealth } from '../src/remote-status.js';

const BASE: ReadinessInput = {
  routeMode: 'idle',
  backingConnected: false,
  backingStreaming: false,
  backingSampleRate: null,
  backingIsRobot: false,
  micConnected: false,
  micStreaming: false,
  micFlowObserved: false,
  robotSourceConnected: false,
  sessionActive: false,
  timelineConnected: false,
  timelineState: null,
  playerOffsetMs: null,
  playerOffsetFresh: false,
  calibrationState: 'idle',
  calibrationValid: false,
  calibrationStale: false,
  calibrationKind: 'none',
  probeCorrelation: { mic: null, backing: null },
  bootCalibration: null,
};

function status(overrides: Partial<ReadinessInput> = {}) {
  return deriveRemoteStatusHealth(buildReadiness({ ...BASE, ...overrides }));
}

describe('remote status health projection', () => {
  test('an empty host is idle rather than failed', () => {
    assert.deepEqual(status(), {
      ok: true,
      state: 'idle',
      faults: [],
      warnings: [],
    });
  });

  test('a connected backing source that stopped flowing is a fault', () => {
    const result = status({
      routeMode: 'legacy',
      backingConnected: true,
      backingStreaming: false,
      backingSampleRate: 48_000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'fault');
    assert.deepEqual(result.faults, [
      'backing source is connected but no longer sending audio',
    ]);
  });

  test('a newly connected Mic before its first frame is not called broken', () => {
    const result = status({
      micConnected: true,
      micStreaming: false,
      micFlowObserved: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'live');
    assert.deepEqual(result.faults, []);
  });

  test('a Mic that flowed and then stalled is a fault', () => {
    const result = status({
      micConnected: true,
      micStreaming: false,
      micFlowObserved: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, 'fault');
    assert.deepEqual(result.faults, [
      'microphone is connected but no longer sending audio',
    ]);
  });

  test('a required route without backing is a fault', () => {
    const result = status({ routeMode: 'song' });
    assert.equal(result.state, 'fault');
    assert.deepEqual(result.faults, ['song route has no backing source']);
  });

  test('Robot route separates missing infrastructure from stale timing quality', () => {
    const missing = status({
      routeMode: 'robot',
      backingConnected: true,
      backingStreaming: true,
      backingSampleRate: 48_000,
      backingIsRobot: true,
      robotSourceConnected: false,
    });
    assert.equal(missing.state, 'fault');
    assert.deepEqual(missing.faults, ['robot route has no source page']);

    const stale = status({
      routeMode: 'robot',
      backingConnected: true,
      backingStreaming: true,
      backingSampleRate: 48_000,
      backingIsRobot: true,
      robotSourceConnected: true,
      playerOffsetFresh: false,
    });
    assert.equal(stale.ok, true);
    assert.equal(stale.state, 'degraded');
    assert.deepEqual(stale.warnings, [
      'robot player delta is stale; alignment fell back to the network estimate',
    ]);
  });

  test('stale calibration is a warning without manufacturing a host fault', () => {
    const result = status({
      backingConnected: true,
      backingStreaming: true,
      backingSampleRate: 48_000,
      calibrationStale: true,
    });
    assert.equal(result.ok, true);
    assert.equal(result.state, 'degraded');
    assert.deepEqual(result.warnings, [
      'timing calibration no longer matches the current capture',
    ]);
  });
});
