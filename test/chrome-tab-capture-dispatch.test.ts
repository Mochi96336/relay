import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAB_CAPTURE_DISPATCH_BACKLOG_MS,
  classifyTabCaptureDispatch,
} from '../chrome-tab-audio-probe/capture-dispatch.js';

test('Chrome tab capture dispatch uses the shared 200 ms realtime budget', () => {
  assert.equal(TAB_CAPTURE_DISPATCH_BACKLOG_MS, 200);

  assert.deepEqual(classifyTabCaptureDispatch({
    currentContextTimeSeconds: 10.2,
    capturedAtContextTimeSeconds: 10,
  }), {
    measurable: true,
    lagMs: 199.9999999999993,
    stale: false,
  });

  const stale = classifyTabCaptureDispatch({
    currentContextTimeSeconds: 10.201,
    capturedAtContextTimeSeconds: 10,
  });
  assert.equal(stale.measurable, true);
  assert.ok((stale.lagMs ?? 0) > 200);
  assert.equal(stale.stale, true);
});

test('legacy raw PCM stays admissible when dispatch age is unavailable', () => {
  assert.deepEqual(classifyTabCaptureDispatch({
    currentContextTimeSeconds: 10,
    capturedAtContextTimeSeconds: null,
  }), {
    measurable: false,
    lagMs: null,
    stale: false,
  });
});

test('capture dispatch rejects invalid backlog budgets', () => {
  assert.throws(
    () => classifyTabCaptureDispatch({
      currentContextTimeSeconds: 10,
      capturedAtContextTimeSeconds: 9,
      backlogMs: 0,
    }),
    /backlogMs must be positive/,
  );
});
