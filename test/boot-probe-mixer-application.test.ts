import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideBootProbeMixerApplication,
  type BootProbeMixerApplicationInput,
} from '../src/boot-probe-mixer-application.js';

function decide(overrides: Partial<BootProbeMixerApplicationInput> = {}) {
  return decideBootProbeMixerApplication({
    activeMicLagMs: 140,
    roomHasSong: true,
    resultMicLagMs: 140,
    pathDifferenceMs: 60,
    calibrationStale: false,
    completedContextMatches: true,
    applicability: 'apply',
    storedDeltaMs: 80,
    currentDeltaMs: 80,
    ...overrides,
  });
}

test('no-Song room applies the measured path difference without a player-relative term', () => {
  assert.deepEqual(decide({
    roomHasSong: false,
    activeMicLagMs: 140,
    pathDifferenceMs: 60,
  }), { kind: 'set', micLagMs: 60 });

  assert.deepEqual(decide({
    roomHasSong: false,
    activeMicLagMs: 60,
    pathDifferenceMs: 60,
  }), { kind: 'hold' });
});

test('no-Song shortcut requires a fresh confirmed result in the current capture context', () => {
  assert.deepEqual(decide({
    roomHasSong: false,
    calibrationStale: true,
    applicability: 'revoke',
  }), { kind: 'set', micLagMs: null });

  assert.deepEqual(decide({
    roomHasSong: false,
    completedContextMatches: false,
    applicability: 'revoke',
  }), { kind: 'set', micLagMs: null });

  assert.deepEqual(decide({
    roomHasSong: false,
    resultMicLagMs: null,
    applicability: 'revoke',
  }), { kind: 'set', micLagMs: null });
});

test('hold applicability preserves the applied total even when live delta moved', () => {
  assert.deepEqual(decide({
    applicability: 'hold',
    currentDeltaMs: 10,
    resultMicLagMs: 999,
  }), { kind: 'hold' });
});

test('revoke applicability clears an applied lag exactly once', () => {
  assert.deepEqual(decide({ applicability: 'revoke' }), { kind: 'set', micLagMs: null });
  assert.deepEqual(decide({
    applicability: 'revoke',
    activeMicLagMs: null,
  }), { kind: 'hold' });
});

test('missing stored delta fails closed instead of promoting provenance-less Boot Probe total', () => {
  assert.deepEqual(decide({ storedDeltaMs: null }), { kind: 'set', micLagMs: null });
  assert.deepEqual(decide({
    storedDeltaMs: null,
    activeMicLagMs: null,
  }), { kind: 'hold' });
});

test('stored/current delta mismatch holds the current mixer total for explicit reapply policy', () => {
  assert.deepEqual(decide({
    storedDeltaMs: 80,
    currentDeltaMs: 90,
    resultMicLagMs: 150,
  }), { kind: 'hold' });
});

test('stored/current delta equality may restore or replace the confirmed result', () => {
  assert.deepEqual(decide({
    activeMicLagMs: 120,
    resultMicLagMs: 140,
  }), { kind: 'set', micLagMs: 140 });

  assert.deepEqual(decide({
    activeMicLagMs: null,
    resultMicLagMs: 140,
  }), { kind: 'set', micLagMs: 140 });

  assert.deepEqual(decide({
    activeMicLagMs: 140,
    resultMicLagMs: 140,
  }), { kind: 'hold' });
});

test('delta comparison preserves the original 0.001 ms fence', () => {
  assert.deepEqual(decide({
    activeMicLagMs: 120,
    resultMicLagMs: 140,
    currentDeltaMs: 80.000999,
  }), { kind: 'set', micLagMs: 140 });

  assert.deepEqual(decide({
    activeMicLagMs: 120,
    resultMicLagMs: 140,
    currentDeltaMs: 80.001,
  }), { kind: 'hold' });
});
