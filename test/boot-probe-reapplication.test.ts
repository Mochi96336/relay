import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideBootProbeReapplication,
  type BootProbeReapplicationInput,
} from '../src/boot-probe-reapplication.js';

function input(
  overrides: Partial<BootProbeReapplicationInput> = {},
): BootProbeReapplicationInput {
  return {
    appliedKind: 'boot-probe',
    replacementApplicability: null,
    roomHasSong: true,
    pathDifferenceReady: true,
    calibrationCollecting: false,
    calibrationTransactionActive: false,
    robotDeltaFresh: true,
    completedContextMatches: true,
    advanceMs: 160,
    appliedMicLagMs: 100,
    reapplyThresholdMs: 40,
    ...overrides,
  };
}

test('boot authority reapplies when the live delta moves beyond hysteresis', () => {
  assert.deepEqual(
    decideBootProbeReapplication(input()),
    { kind: 'reapply', reason: 'delta-moved', advanceMs: 160 },
  );
});

test('movement strictly below the reapply threshold is held', () => {
  assert.deepEqual(
    decideBootProbeReapplication(input({ advanceMs: 139.999 })),
    { kind: 'none' },
  );
});

test('movement exactly at the reapply threshold is applied', () => {
  assert.deepEqual(
    decideBootProbeReapplication(input({ advanceMs: 140 })),
    { kind: 'reapply', reason: 'delta-moved', advanceMs: 140 },
  );
});

test('a missing active mixer lag does not suppress a valid boot update', () => {
  assert.deepEqual(
    decideBootProbeReapplication(input({ appliedMicLagMs: null })),
    { kind: 'reapply', reason: 'delta-moved', advanceMs: 160 },
  );
});

test('revoked non-boot authority lets the boot baseline reclaim the mixer', () => {
  assert.deepEqual(
    decideBootProbeReapplication(input({
      appliedKind: 'content',
      replacementApplicability: 'revoke',
    })),
    { kind: 'reapply', reason: 'reclaim', advanceMs: 160 },
  );
});

test('applicable or held non-boot authority cannot be displaced by boot evidence', () => {
  for (const replacementApplicability of ['apply', 'hold', null] as const) {
    assert.deepEqual(
      decideBootProbeReapplication(input({
        appliedKind: 'content',
        replacementApplicability,
      })),
      { kind: 'none' },
    );
  }
});

test('no confirmed authority may also be reclaimed when its applicability is revoke', () => {
  assert.deepEqual(
    decideBootProbeReapplication(input({
      appliedKind: 'none',
      replacementApplicability: 'revoke',
      appliedMicLagMs: null,
    })),
    { kind: 'reapply', reason: 'reclaim', advanceMs: 160 },
  );
});

test('room, evidence, transaction, delta, and context gates each block reapply', () => {
  const blocked: Partial<BootProbeReapplicationInput>[] = [
    { roomHasSong: false },
    { pathDifferenceReady: false },
    { calibrationCollecting: true },
    { calibrationTransactionActive: true },
    { robotDeltaFresh: false },
    { completedContextMatches: false },
    { advanceMs: null },
  ];

  for (const override of blocked) {
    assert.deepEqual(decideBootProbeReapplication(input(override)), { kind: 'none' });
  }
});
