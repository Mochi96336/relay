import assert from 'node:assert/strict';
import test from 'node:test';

import {
  autoContentCalibrationAuthorityAllowsStart,
  autoContentCalibrationLivePathReady,
  autoContentCalibrationPrerequisitesReady,
  autoContentCalibrationStartMode,
  type AutoContentCalibrationAuthorityInput,
  type AutoContentCalibrationLivePathInput,
  type AutoContentCalibrationPrerequisiteInput,
} from '../src/auto-content-calibration-policy.js';

function prerequisites(
  overrides: Partial<AutoContentCalibrationPrerequisiteInput> = {},
): AutoContentCalibrationPrerequisiteInput {
  return {
    bootProbeSettled: true,
    robotRouteActive: false,
    robotEvidenceMappingReady: false,
    sessionActive: true,
    calibrationCollecting: false,
    ...overrides,
  };
}

function authority(
  overrides: Partial<AutoContentCalibrationAuthorityInput> = {},
): AutoContentCalibrationAuthorityInput {
  return {
    freshConfirmedResult: false,
    robotRouteActive: false,
    appliedKind: null,
    ...overrides,
  };
}

function livePath(
  overrides: Partial<AutoContentCalibrationLivePathInput> = {},
): AutoContentCalibrationLivePathInput {
  return {
    retryDue: true,
    backingConnected: true,
    micControlConnected: true,
    streamsFlowing: true,
    timelineConnected: true,
    timelinePlaying: true,
    ...overrides,
  };
}

test('prerequisites wait for Boot settlement and an active idle session', () => {
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites()), true);
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites({ bootProbeSettled: false })), false);
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites({ sessionActive: false })), false);
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites({ calibrationCollecting: true })), false);
});

test('Robot prerequisites require evidence mapping while non-Robot does not', () => {
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites({
    robotRouteActive: true,
    robotEvidenceMappingReady: false,
  })), false);
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites({
    robotRouteActive: true,
    robotEvidenceMappingReady: true,
  })), true);
  assert.equal(autoContentCalibrationPrerequisitesReady(prerequisites({
    robotRouteActive: false,
    robotEvidenceMappingReady: false,
  })), true);
});

test('authority admits missing/stale replacement and Robot boot-to-content promotion', () => {
  assert.equal(autoContentCalibrationAuthorityAllowsStart(authority()), true);
  assert.equal(autoContentCalibrationAuthorityAllowsStart(authority({
    freshConfirmedResult: true,
    robotRouteActive: false,
  })), false);
  assert.equal(autoContentCalibrationAuthorityAllowsStart(authority({
    freshConfirmedResult: true,
    robotRouteActive: true,
    appliedKind: 'boot-probe',
  })), true);
  assert.equal(autoContentCalibrationAuthorityAllowsStart(authority({
    freshConfirmedResult: true,
    robotRouteActive: true,
    appliedKind: 'content',
  })), false);
  assert.equal(autoContentCalibrationAuthorityAllowsStart(authority({
    freshConfirmedResult: true,
    robotRouteActive: true,
    appliedKind: null,
  })), false, 'a required but unsampled applied authority must fail closed');
});

test('live admission requires retry, both transports, both streams and a playing timeline', () => {
  assert.equal(autoContentCalibrationLivePathReady(livePath()), true);
  for (const overrides of [
    { retryDue: false },
    { backingConnected: false },
    { micControlConnected: false },
    { streamsFlowing: false },
    { timelineConnected: false },
    { timelinePlaying: false },
  ]) {
    assert.equal(autoContentCalibrationLivePathReady(livePath(overrides)), false);
  }
});

test('only an exhausted bounded Boot probe reuses primed evidence', () => {
  assert.equal(autoContentCalibrationStartMode(false), 'fresh');
  assert.equal(autoContentCalibrationStartMode(true), 'primed');
});
