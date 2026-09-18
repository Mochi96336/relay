import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bootProbeStartAuthorityAllowsAttempt,
  selectBootProbeStartTarget,
} from '../src/boot-probe-start-policy.js';

test('fresh settled Boot authority suppresses a redundant automatic probe', () => {
  assert.equal(bootProbeStartAuthorityAllowsAttempt({
    candidateIsBootProbe: true,
    hasCalibrationResult: true,
    calibrationStale: false,
    calibrationTransactionActive: false,
  }), false);
});

test('stale or absent Boot authority leaves the scheduler open', () => {
  assert.equal(bootProbeStartAuthorityAllowsAttempt({
    candidateIsBootProbe: true,
    hasCalibrationResult: true,
    calibrationStale: true,
    calibrationTransactionActive: false,
  }), true);
  assert.equal(bootProbeStartAuthorityAllowsAttempt({
    candidateIsBootProbe: true,
    hasCalibrationResult: false,
    calibrationStale: false,
    calibrationTransactionActive: false,
  }), true);
  assert.equal(bootProbeStartAuthorityAllowsAttempt({
    candidateIsBootProbe: false,
    hasCalibrationResult: true,
    calibrationStale: false,
    calibrationTransactionActive: false,
  }), true);
});

test('replacement transaction stays open despite a retained fresh result', () => {
  assert.equal(bootProbeStartAuthorityAllowsAttempt({
    candidateIsBootProbe: true,
    hasCalibrationResult: true,
    calibrationStale: false,
    calibrationTransactionActive: true,
  }), true);
});

test('probe failure blocks a new logical target until lifecycle recovery', () => {
  assert.equal(selectBootProbeStartTarget({
    probeErrored: true,
    calibrationTransactionActive: false,
    hasMicLeg: false,
    completedContextMatches: false,
  }), null);
});

test('completed matching context deduplicates settled automatic mic start', () => {
  assert.equal(selectBootProbeStartTarget({
    probeErrored: false,
    calibrationTransactionActive: false,
    hasMicLeg: false,
    completedContextMatches: true,
  }), null);
});

test('replacement transaction may start Mic even with retained completed context', () => {
  assert.equal(selectBootProbeStartTarget({
    probeErrored: false,
    calibrationTransactionActive: true,
    hasMicLeg: false,
    completedContextMatches: true,
  }), 'mic');
});

test('scheduler selects Mic first and backing after a valid Mic leg', () => {
  assert.equal(selectBootProbeStartTarget({
    probeErrored: false,
    calibrationTransactionActive: false,
    hasMicLeg: false,
    completedContextMatches: false,
  }), 'mic');
  assert.equal(selectBootProbeStartTarget({
    probeErrored: false,
    calibrationTransactionActive: false,
    hasMicLeg: true,
    completedContextMatches: false,
  }), 'backing');
});
