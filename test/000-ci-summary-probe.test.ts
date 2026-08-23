import test from 'node:test';
import assert from 'node:assert/strict';

test('CI summary probe preserves an early assertion failure', () => {
  assert.equal('actual-ci-summary-probe', 'expected-ci-summary-probe');
});
