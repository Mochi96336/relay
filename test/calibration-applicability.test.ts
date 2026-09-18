import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideCalibrationApplicability,
  type CalibrationApplicabilityInput,
} from '../src/calibration-applicability.js';

function input(
  overrides: Partial<CalibrationApplicabilityInput> = {},
): CalibrationApplicabilityInput {
  return {
    kind: 'content',
    hasResult: true,
    stale: false,
    calibrationTransactionActive: false,
    calibrationProvisional: false,
    hasConfirmedResult: true,
    robotProbeTimingActive: false,
    bootProbeSettled: true,
    robotRouteActive: false,
    robotSourceConnected: false,
    roomHasSong: false,
    robotDeltaFresh: false,
    robotDeltaEverEstablished: false,
    robotContentMappingReady: false,
    ...overrides,
  };
}

test('missing or stale measurement is always revoked', () => {
  assert.equal(decideCalibrationApplicability(input({ hasResult: false })), 'revoke');
  assert.equal(decideCalibrationApplicability(input({ stale: true })), 'revoke');
});

test('preferred unsettled boot probe revokes non-boot authority unless a confirmed result is retained', () => {
  const preferred = {
    robotProbeTimingActive: true,
    bootProbeSettled: false,
  } as const;
  assert.equal(decideCalibrationApplicability(input(preferred)), 'revoke');
  assert.equal(decideCalibrationApplicability(input({
    ...preferred,
    calibrationTransactionActive: true,
    calibrationProvisional: false,
    hasConfirmedResult: true,
  })), 'apply');
  assert.equal(decideCalibrationApplicability(input({
    ...preferred,
    calibrationTransactionActive: true,
    calibrationProvisional: true,
    hasConfirmedResult: true,
  })), 'revoke');
  assert.equal(decideCalibrationApplicability(input({
    ...preferred,
    calibrationTransactionActive: true,
    calibrationProvisional: false,
    hasConfirmedResult: false,
  })), 'revoke');
});

test('boot authority itself is not revoked merely because its strategy is still settling', () => {
  assert.equal(decideCalibrationApplicability(input({
    kind: 'boot-probe',
    robotProbeTimingActive: true,
    bootProbeSettled: false,
  })), 'apply');
});

test('a disconnected Robot source revokes authority before quiet-heartbeat hold can apply', () => {
  assert.equal(decideCalibrationApplicability(input({
    kind: 'boot-probe',
    robotRouteActive: true,
    robotSourceConnected: false,
    roomHasSong: true,
    robotDeltaFresh: false,
    robotDeltaEverEstablished: true,
  })), 'revoke');
});

test('path-only boot authority needs no player delta while the room has no Song', () => {
  assert.equal(decideCalibrationApplicability(input({
    kind: 'boot-probe',
    robotRouteActive: true,
    robotSourceConnected: true,
    roomHasSong: false,
    robotDeltaFresh: false,
    robotDeltaEverEstablished: false,
  })), 'apply');
});

test('boot authority distinguishes a never-established Song delta from a quiet heartbeat', () => {
  const quiet = {
    kind: 'boot-probe',
    robotRouteActive: true,
    robotSourceConnected: true,
    roomHasSong: true,
    robotDeltaFresh: false,
  } as const;
  assert.equal(decideCalibrationApplicability(input({
    ...quiet,
    robotDeltaEverEstablished: false,
  })), 'revoke');
  assert.equal(decideCalibrationApplicability(input({
    ...quiet,
    robotDeltaEverEstablished: true,
  })), 'hold');
  assert.equal(decideCalibrationApplicability(input({
    ...quiet,
    robotDeltaFresh: true,
    robotDeltaEverEstablished: true,
  })), 'apply');
});

test('content authority distinguishes an absent mapping from a temporarily quiet established one', () => {
  const unmapped = {
    kind: 'content',
    robotRouteActive: true,
    robotSourceConnected: true,
    robotContentMappingReady: false,
  } as const;
  assert.equal(decideCalibrationApplicability(input({
    ...unmapped,
    robotDeltaEverEstablished: false,
  })), 'revoke');
  assert.equal(decideCalibrationApplicability(input({
    ...unmapped,
    robotDeltaEverEstablished: true,
  })), 'hold');
  assert.equal(decideCalibrationApplicability(input({
    ...unmapped,
    robotContentMappingReady: true,
    robotDeltaEverEstablished: true,
  })), 'apply');
});

test('Robot-only live dependencies do not gate a non-Robot room', () => {
  assert.equal(decideCalibrationApplicability(input({
    robotRouteActive: false,
    robotSourceConnected: false,
    robotDeltaFresh: false,
    robotContentMappingReady: false,
  })), 'apply');
});
