import assert from 'node:assert/strict';
import test from 'node:test';

import { TimingRuntime } from '../src/timing-runtime.js';

function runtime() {
  return new TimingRuntime({ autoCalibrationRetryMs: 15_000 });
}

test('timing runtime starts with no calibration authority and an immediately eligible auto retry', () => {
  const timing = runtime();

  assert.equal(timing.calibrationKind, 'none');
  assert.equal(timing.automatic, false);
  assert.equal(timing.autoCalibrationDue(0), true);
  assert.equal(timing.contentValidationBaselineRevision, -1);
  assert.equal(timing.contentValidationSlewRevision, null);
});

test('automatic content calibration owns the retry timestamp while manual content does not move it', () => {
  const timing = runtime();

  timing.beginContentCalibration(10_000, true);
  assert.equal(timing.calibrationKind, 'content');
  assert.equal(timing.automatic, true);
  assert.equal(timing.autoCalibrationDue(24_999), false);
  assert.equal(timing.autoCalibrationDue(25_000), true);

  timing.beginContentCalibration(20_000, false);
  assert.equal(timing.calibrationKind, 'content');
  assert.equal(timing.automatic, false);
  assert.equal(
    timing.autoCalibrationDue(25_000),
    true,
    'manual calibration must not postpone the existing automatic retry schedule',
  );
});

test('boot probe and validated content promotion change kind without inventing measurement authority', () => {
  const timing = runtime();

  timing.beginBootProbe(true);
  assert.equal(timing.calibrationKind, 'boot-probe');
  assert.equal(timing.automatic, true);

  timing.markContentAuthority();
  assert.equal(timing.calibrationKind, 'content');
  assert.equal(
    timing.automatic,
    true,
    'validator promotion keeps the run provenance instead of silently rewriting automatic/manual state',
  );

  timing.markBootProbeAuthority();
  assert.equal(timing.calibrationKind, 'boot-probe');
  assert.equal(
    timing.automatic,
    true,
    'a settled/failing probe may reaffirm boot authority without changing how the run began',
  );

  timing.clearCalibrationKind();
  assert.equal(timing.calibrationKind, 'none');
  assert.equal(timing.automatic, true, 'clearing authority does not rewrite historical run provenance');
});

test('resetting the automatic schedule makes the next auto calibration immediately eligible', () => {
  const timing = runtime();

  timing.beginContentCalibration(100_000, true);
  assert.equal(timing.autoCalibrationDue(100_001), false);

  timing.resetAutoCalibrationSchedule();
  assert.equal(timing.autoCalibrationDue(100_001), true);
});

test('content validation baseline and slew revision form one bounded promotion state', () => {
  const timing = runtime();

  timing.markContentValidationBaseline(7);
  timing.prepareContentValidationSlew(8);
  assert.equal(timing.contentValidationBaselineRevision, 7);
  assert.equal(timing.contentValidationSlewRevision, 8);
  assert.equal(timing.contentValidationSlewMatches(8), true);
  assert.equal(timing.contentValidationSlewMatches(7), false);

  timing.clearContentValidationSlew();
  assert.equal(timing.contentValidationBaselineRevision, 7);
  assert.equal(timing.contentValidationSlewRevision, null);

  timing.prepareContentValidationSlew(9);
  timing.clearContentValidationBaseline();
  assert.equal(timing.contentValidationBaselineRevision, -1);
  assert.equal(timing.contentValidationSlewRevision, null);
});

test('invalid automatic retry windows fail closed at construction', () => {
  assert.throws(
    () => new TimingRuntime({ autoCalibrationRetryMs: 0 }),
    /positive finite number/,
  );
  assert.throws(
    () => new TimingRuntime({ autoCalibrationRetryMs: Number.POSITIVE_INFINITY }),
    /positive finite number/,
  );
});
