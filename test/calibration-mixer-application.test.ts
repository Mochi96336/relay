import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideCalibrationMixerApplication,
  type CalibrationMixerApplicationInput,
} from '../src/calibration-mixer-application.js';

function input(
  overrides: Partial<CalibrationMixerApplicationInput> = {},
): CalibrationMixerApplicationInput {
  return {
    applicability: 'apply',
    calibrationKind: 'content',
    activeMicLagMs: 100,
    nextMicLagMs: 160,
    robotContentAuthority: true,
    hasContentValidationSlew: false,
    contentValidationSlewMatchesRevision: false,
    calibratedMicLagTarget: null,
    jitterThresholdMs: 20,
    ...overrides,
  };
}

test('hold applicability preserves the mixer and prepared slew state', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      applicability: 'hold',
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: true,
    })),
    { kind: 'none', clearContentValidationSlew: false },
  );
});

test('Robot content jitter strictly below the threshold is ignored', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({ nextMicLagMs: 119.999 })),
    { kind: 'none', clearContentValidationSlew: false },
  );
});

test('Robot content movement exactly at the threshold is applied', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({ nextMicLagMs: 120 })),
    { kind: 'set', micLagMs: 120, clearContentValidationSlew: true },
  );
});

test('any prepared validation slew bypasses jitter hold even when its revision is stale', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      nextMicLagMs: 110,
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: false,
    })),
    { kind: 'set', micLagMs: 110, clearContentValidationSlew: true },
  );
});

test('matching an already-applied lag only clears a matching validation slew', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      nextMicLagMs: 100,
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: true,
    })),
    { kind: 'none', clearContentValidationSlew: true },
  );
  assert.deepEqual(
    decideCalibrationMixerApplication(input({ nextMicLagMs: 100 })),
    { kind: 'none', clearContentValidationSlew: false },
  );
});

test('drift-confirmed content correction slews when both endpoints exist', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: true,
    })),
    { kind: 'slew', micLagMs: 160, clearContentValidationSlew: true },
  );
});

test('validated content with no active lag sets directly instead of slewing from null', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      activeMicLagMs: null,
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: true,
    })),
    { kind: 'set', micLagMs: 160, clearContentValidationSlew: true },
  );
});

test('periodic synchronization leaves an identical in-progress slew target alone', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: false,
      calibratedMicLagTarget: 160,
    })),
    { kind: 'none', clearContentValidationSlew: false },
  );
});

test('revoke clears an active lag and stale validation slew state', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      applicability: 'revoke',
      nextMicLagMs: null,
      hasContentValidationSlew: true,
    })),
    { kind: 'set', micLagMs: null, clearContentValidationSlew: true },
  );
});

test('revoke with an already-null lag clears only a matching validation slew', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      applicability: 'revoke',
      activeMicLagMs: null,
      nextMicLagMs: null,
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: true,
    })),
    { kind: 'none', clearContentValidationSlew: true },
  );
});

test('a prepared slew never grants slew semantics to a non-content authority', () => {
  assert.deepEqual(
    decideCalibrationMixerApplication(input({
      calibrationKind: 'none',
      robotContentAuthority: false,
      hasContentValidationSlew: true,
      contentValidationSlewMatchesRevision: true,
    })),
    { kind: 'set', micLagMs: 160, clearContentValidationSlew: true },
  );
});
