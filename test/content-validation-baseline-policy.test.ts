import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideContentValidationBaselineSync,
  type ContentValidationBaselineSyncInput,
} from '../src/content-validation-baseline-policy.js';

function input(
  overrides: Partial<ContentValidationBaselineSyncInput> = {},
): ContentValidationBaselineSyncInput {
  return {
    appliedKind: 'content',
    hasConfirmedResult: true,
    calibrationStale: false,
    hasBaseline: true,
    baselineRevision: 4,
    confirmedRevision: 4,
    ...overrides,
  };
}

test('non-content authority clears an existing content validation baseline', () => {
  assert.equal(decideContentValidationBaselineSync(input({ appliedKind: 'boot-probe' })), 'clear');
  assert.equal(decideContentValidationBaselineSync(input({ appliedKind: 'none' })), 'clear');
});

test('invalid authority is a no-op when no validator baseline exists', () => {
  assert.equal(decideContentValidationBaselineSync(input({
    appliedKind: 'boot-probe',
    hasBaseline: false,
  })), 'none');
  assert.equal(decideContentValidationBaselineSync(input({
    hasConfirmedResult: false,
    hasBaseline: false,
  })), 'none');
});

test('missing or stale confirmed content authority clears an existing baseline', () => {
  assert.equal(decideContentValidationBaselineSync(input({ hasConfirmedResult: false })), 'clear');
  assert.equal(decideContentValidationBaselineSync(input({ calibrationStale: true })), 'clear');
});

test('matching confirmed revision keeps an existing baseline', () => {
  assert.equal(decideContentValidationBaselineSync(input()), 'none');
});

test('a missing validator baseline is reseeded even when the revision marker matches', () => {
  assert.equal(decideContentValidationBaselineSync(input({ hasBaseline: false })), 'set');
});

test('a new confirmed revision reseeds the baseline', () => {
  assert.equal(decideContentValidationBaselineSync(input({ confirmedRevision: 5 })), 'set');
});
