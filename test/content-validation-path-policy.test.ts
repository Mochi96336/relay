import assert from 'node:assert/strict';
import test from 'node:test';

import {
  contentValidationAuthorityReady,
  contentValidationLivePathReady,
  contentValidationPathPrerequisitesReady,
  type ContentValidationAuthorityInput,
  type ContentValidationLivePathInput,
  type ContentValidationPathPrerequisiteInput,
} from '../src/content-validation-path-policy.js';

function prerequisites(
  overrides: Partial<ContentValidationPathPrerequisiteInput> = {},
): ContentValidationPathPrerequisiteInput {
  return {
    enabled: true,
    takeBlocked: false,
    bootProbeSettled: true,
    robotRouteActive: false,
    robotEvidenceMappingReady: false,
    sessionActive: true,
    calibrationCollecting: false,
    ...overrides,
  };
}

function authority(
  overrides: Partial<ContentValidationAuthorityInput> = {},
): ContentValidationAuthorityInput {
  return {
    appliedKind: 'content',
    hasConfirmedResult: true,
    calibrationStale: false,
    ...overrides,
  };
}

function livePath(
  overrides: Partial<ContentValidationLivePathInput> = {},
): ContentValidationLivePathInput {
  return {
    backingConnected: true,
    micControlConnected: true,
    streamsFlowing: true,
    timelineConnected: true,
    timelinePlaying: true,
    ...overrides,
  };
}

test('prerequisites admit an active settled non-Robot session', () => {
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites()), true);
});

test('feature and Take gates reject before authority sampling', () => {
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({ enabled: false })), false);
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({ takeBlocked: true })), false);
});

test('prerequisites wait for bounded Boot settlement', () => {
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({ bootProbeSettled: false })), false);
});

test('Robot prerequisites require evidence mapping while non-Robot does not', () => {
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({
    robotRouteActive: true,
    robotEvidenceMappingReady: false,
  })), false);
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({
    robotRouteActive: true,
    robotEvidenceMappingReady: true,
  })), true);
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({
    robotRouteActive: false,
    robotEvidenceMappingReady: false,
  })), true);
});

test('inactive sessions and active calibration collection reject before authority sampling', () => {
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({ sessionActive: false })), false);
  assert.equal(contentValidationPathPrerequisitesReady(prerequisites({ calibrationCollecting: true })), false);
});

test('authority gate only admits fresh confirmed applied content authority', () => {
  assert.equal(contentValidationAuthorityReady(authority()), true);
  assert.equal(contentValidationAuthorityReady(authority({ appliedKind: 'boot-probe' })), false);
  assert.equal(contentValidationAuthorityReady(authority({ appliedKind: 'none' })), false);
  assert.equal(contentValidationAuthorityReady(authority({ hasConfirmedResult: false })), false);
  assert.equal(contentValidationAuthorityReady(authority({ calibrationStale: true })), false);
});

test('live path requires both controls, PCM flow, and a connected playing timeline', () => {
  assert.equal(contentValidationLivePathReady(livePath()), true);
  assert.equal(contentValidationLivePathReady(livePath({ backingConnected: false })), false);
  assert.equal(contentValidationLivePathReady(livePath({ micControlConnected: false })), false);
  assert.equal(contentValidationLivePathReady(livePath({ streamsFlowing: false })), false);
  assert.equal(contentValidationLivePathReady(livePath({ timelineConnected: false })), false);
  assert.equal(contentValidationLivePathReady(livePath({ timelinePlaying: false })), false);
});
