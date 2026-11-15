import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CalibrationAuthorityJournal } from '../src/calibration-authority-journal.js';

test('a calibration applied, withdrawn or re-labelled is journaled at once', () => {
  const j = new CalibrationAuthorityJournal();
  const content = (appliedMs: number | null, applicability: 'apply' | 'hold' | 'revoke' = 'apply') =>
    ({ kind: 'content' as const, applicability, appliedMs });
  assert.equal(j.note({ kind: 'none', applicability: 'revoke', appliedMs: null }, 0), 'start');
  assert.equal(j.note({ kind: 'none', applicability: 'revoke', appliedMs: null }, 500), null);
  // 2026-11-03: applied, withdrawn 12 s later, applied again 7 s after that.
  assert.equal(j.note(content(-54), 1000), 'authority');
  assert.equal(j.note(content(-54, 'hold'), 1001), 'authority', 'a hold is a different decision');
  assert.equal(j.note(content(-54), 1002), 'authority');
  assert.equal(j.note(content(null, 'revoke'), 13_000), 'authority');
  assert.equal(j.note(content(null), 13_001), 'authority', 'applicable again before the mixer has it');
  assert.equal(j.note(content(-54), 20_000), 'authority');
  assert.equal(j.note({ kind: 'boot-probe', applicability: 'apply', appliedMs: -54 }, 20_001), 'authority');
});

test('movement alone is journaled past 20 ms, at most once a second', () => {
  const j = new CalibrationAuthorityJournal();
  const boot = (appliedMs: number) => ({ kind: 'boot-probe' as const, applicability: 'apply' as const, appliedMs });
  assert.equal(j.note(boot(95), 0), 'start');
  assert.equal(j.note(boot(80), 5000), null, 'under the move threshold');
  assert.equal(j.note(boot(-334), 400), null, 'within a second of the last line');
  assert.equal(j.note(boot(-334), 1000), 'move');
  assert.equal(j.note(boot(-317), 9000), null);
  j.reset();
  assert.equal(j.note(boot(-317), 9001), 'start');
});

test('the server journals the decision with its inputs on the timing tick', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const start = server.indexOf('function noteCalibrationAuthority(');
  const body = server.slice(start, server.indexOf('\n}\n', start));
  // One call returns the decision and its inputs, so the line cannot pair a
  // decision with inputs sampled at another moment.
  assert.match(body, /const \{ applicability, evidence \} = calibrationAlignment\.applicabilityDecision\(\);/);
  assert.match(body, /console\.warn\('\[mic-calibration\]'/);
  assert.match(body, /\.\.\.evidence/);
  assert.match(body, /if \(!session\.active \|\| !participants\.micOwnerId\) \{\s*calibrationAuthorityJournal\.reset\(\);/);
  assert.match(server, /noteCalibrationAuthority\(nowMs\);\s*logMicReadHeadEvents\(\);/);
});
