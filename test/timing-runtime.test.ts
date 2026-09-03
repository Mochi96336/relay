import assert from 'node:assert/strict';
import test from 'node:test';

import { TimingRuntime } from '../src/timing-runtime.js';

function runtime() {
  return new TimingRuntime({ autoCalibrationRetryMs: 15_000 });
}

test('timing runtime starts with no calibration authority and an immediately eligible auto retry', () => {
  const timing = runtime();

  assert.equal(timing.calibrationKind, 'none');
  assert.equal(timing.authorityKind, 'none');
  assert.equal(timing.authorityRevision, 0);
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

test('candidate kind cannot reclassify a retained confirmed authority revision', () => {
  const timing = runtime();

  timing.beginContentCalibration(1_000, false);
  assert.equal(timing.appliedCalibrationKind({
    confirmedRevision: 1,
    hasConfirmedResult: true,
    provisional: false,
  }), 'content');
  assert.equal(timing.authorityKind, 'content');

  timing.beginBootProbe(false);
  assert.equal(timing.calibrationKind, 'boot-probe', 'replacement candidate uses boot probes');
  assert.equal(
    timing.appliedCalibrationKind({
      confirmedRevision: 1,
      hasConfirmedResult: true,
      provisional: false,
    }),
    'content',
    'same confirmed revision must keep the strategy that actually produced it',
  );
  assert.equal(timing.authorityKind, 'content');

  timing.restoreCandidateKindToAuthority();
  assert.equal(timing.calibrationKind, 'content', 'failed replacement rolls orchestration back to retained authority');
});

test('failed candidate keeps its own provenance when there is no confirmed authority to restore', () => {
  const timing = runtime();

  timing.beginBootProbe(false);
  assert.equal(timing.calibrationKind, 'boot-probe');
  assert.equal(timing.authorityKind, 'none');

  timing.restoreCandidateKindToAuthority();
  assert.equal(
    timing.calibrationKind,
    'boot-probe',
    'a first-run terminal failure must remain identifiable as a failed boot-probe',
  );
  assert.equal(timing.authorityKind, 'none');
});

test('new confirmation revision atomically promotes candidate strategy to authority', () => {
  const timing = runtime();

  timing.beginContentCalibration(1_000, false);
  timing.appliedCalibrationKind({
    confirmedRevision: 4,
    hasConfirmedResult: true,
    provisional: false,
  });

  timing.beginBootProbe(false);
  assert.equal(timing.authorityKind, 'content');
  assert.equal(timing.appliedCalibrationKind({
    confirmedRevision: 5,
    hasConfirmedResult: true,
    provisional: false,
  }), 'boot-probe');
  assert.equal(timing.authorityKind, 'boot-probe');
  assert.equal(timing.authorityRevision, 5);
});

test('provisional result belongs to the in-flight candidate without mutating confirmed provenance', () => {
  const timing = runtime();

  timing.beginBootProbe(false);
  assert.equal(timing.appliedCalibrationKind({
    confirmedRevision: 0,
    hasConfirmedResult: false,
    provisional: true,
  }), 'boot-probe');
  assert.equal(timing.authorityKind, 'none');

  timing.beginContentCalibration(2_000, false);
  assert.equal(timing.appliedCalibrationKind({
    confirmedRevision: 0,
    hasConfirmedResult: false,
    provisional: true,
  }), 'content');
  assert.equal(timing.authorityKind, 'none');
});

test('clearing a confirmed result clears active authority without rewinding monotonic revision', () => {
  const timing = runtime();

  timing.beginContentCalibration(1_000, false);
  timing.appliedCalibrationKind({
    confirmedRevision: 3,
    hasConfirmedResult: true,
    provisional: false,
  });
  assert.equal(timing.authorityKind, 'content');

  assert.equal(timing.appliedCalibrationKind({
    confirmedRevision: 3,
    hasConfirmedResult: false,
    provisional: false,
  }), 'none');
  assert.equal(timing.authorityKind, 'none');
  assert.equal(timing.authorityRevision, 3);
});

test('boot probe and validated content promotion change candidate kind without inventing measurement authority', () => {
  const timing = runtime();

  timing.beginBootProbe(true);
  assert.equal(timing.calibrationKind, 'boot-probe');
  assert.equal(timing.authorityKind, 'none');
  assert.equal(timing.automatic, true);

  timing.markContentAuthority();
  assert.equal(timing.calibrationKind, 'content');
  assert.equal(timing.authorityKind, 'none');
  assert.equal(
    timing.automatic,
    true,
    'validator promotion keeps the run provenance instead of silently rewriting automatic/manual state',
  );

  timing.markBootProbeAuthority();
  assert.equal(timing.calibrationKind, 'boot-probe');
  assert.equal(timing.authorityKind, 'none');
  assert.equal(
    timing.automatic,
    true,
    'preparing a probe promotion must not claim confirmed authority before its result lands',
  );

  timing.clearCalibrationKind();
  assert.equal(timing.calibrationKind, 'none');
  assert.equal(timing.authorityKind, 'none');
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
  const timing = runtime();

  assert.throws(
    () => new TimingRuntime({ autoCalibrationRetryMs: 0 }),
    /positive finite number/,
  );
  assert.throws(
    () => new TimingRuntime({ autoCalibrationRetryMs: Number.POSITIVE_INFINITY }),
    /positive finite number/,
  );
});

test('invalid confirmed authority revision fails closed', () => {
  const timing = runtime();
  timing.beginContentCalibration(0, false);

  assert.throws(
    () => timing.appliedCalibrationKind({
      confirmedRevision: -1,
      hasConfirmedResult: true,
      provisional: false,
    }),
    /confirmedRevision must be a non-negative safe integer/,
  );
});
