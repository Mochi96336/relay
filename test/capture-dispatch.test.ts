import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS,
  classifyCaptureDispatch,
} from '../public/capture-dispatch.js';

test('capture dispatch shares the 200 ms realtime backlog budget', () => {
  assert.equal(DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS, 200);
  const fresh = classifyCaptureDispatch({
    currentContextTimeSeconds: 10.18,
    capturedAtContextTimeSeconds: 10,
  });
  assert.equal(fresh.measurable, true);
  assert.ok(fresh.lagMs !== null && Math.abs(fresh.lagMs - 180) < 0.001);
  assert.equal(fresh.stale, false);
  assert.equal(
    classifyCaptureDispatch({
      currentContextTimeSeconds: 10.25,
      capturedAtContextTimeSeconds: 10,
    }).stale,
    true,
  );
});

test('capture dispatch never treats clock skew ahead as stale', () => {
  const result = classifyCaptureDispatch({
    currentContextTimeSeconds: 9.99,
    capturedAtContextTimeSeconds: 10,
  });
  assert.equal(result.measurable, true);
  assert.equal(result.lagMs, 0);
  assert.equal(result.stale, false);
});

test('capture dispatch fails open for legacy un-timestamped chunks', () => {
  assert.deepEqual(
    classifyCaptureDispatch({
      currentContextTimeSeconds: 10,
      capturedAtContextTimeSeconds: null,
    }),
    { measurable: false, lagMs: null, stale: false },
  );
});

test('capture dispatch rejects invalid realtime budgets', () => {
  assert.throws(
    () => classifyCaptureDispatch({
      currentContextTimeSeconds: 10,
      capturedAtContextTimeSeconds: 9,
      backlogMs: 0,
    }),
    /backlogMs must be positive/,
  );
});
