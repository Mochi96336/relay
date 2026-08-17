import assert from 'node:assert/strict';
import test from 'node:test';

import { ProbeLifecycle } from '../src/probe-lifecycle.js';

function request(target: 'mic' | 'backing', requestId: number, sentAt = 0) {
  return {
    target,
    requestId,
    serverSentAtMs: sentAt,
    sessionGeneration: 7,
    generation: 11,
  };
}

test('a stale probe reply cannot clear the current request', () => {
  const lifecycle = new ProbeLifecycle(3, 100);
  assert.equal(lifecycle.beginRequest(request('mic', 2)), true);

  assert.equal(lifecycle.acceptReply(1), null);
  assert.equal(lifecycle.pendingRequest?.requestId, 2);

  assert.equal(lifecycle.acceptReply(2)?.requestId, 2);
  assert.equal(lifecycle.pendingRequest, null);
});

test('probe retries are bounded and settle on a terminal failure', () => {
  const lifecycle = new ProbeLifecycle(2, 100);

  assert.equal(lifecycle.beginRequest(request('mic', 1)), true);
  assert.equal(lifecycle.failAttempt('mic', 'no acknowledgement', 10), null);
  assert.equal(lifecycle.canStart('mic', 109), false);
  assert.equal(lifecycle.canStart('mic', 110), true);

  assert.equal(lifecycle.beginRequest(request('mic', 2, 110)), true);
  const failure = lifecycle.failAttempt('mic', 'no acknowledgement', 120);
  assert.match(failure?.message ?? '', /Phone microphone timing probe failed after 2 attempts/);

  const status = lifecycle.status(1_000);
  assert.equal(status.active, false);
  assert.equal(status.phase, 'failed');
  assert.equal(status.attempts.mic, 2);
  assert.equal(status.maxAttempts, 2);
  assert.equal(lifecycle.canStart('mic', 10_000), false, 'terminal failure must not auto-beep forever');
});

test('a backing retry keeps the successful microphone leg', () => {
  const lifecycle = new ProbeLifecycle(3, 100);
  lifecycle.setMicMeasured(true);

  assert.equal(lifecycle.beginRequest(request('backing', 9)), true);
  assert.equal(lifecycle.failAttempt('backing', 'correlation too low', 50), null);

  assert.equal(lifecycle.status(75).phase, 'backing-retry-wait');
  assert.equal(lifecycle.status(150).phase, 'backing-waiting');
  assert.equal(lifecycle.canStart('mic', 150), true, 'lifecycle itself stays generic');
  assert.equal(lifecycle.canStart('backing', 150), true);
});

test('reset clears terminal failure and retry history for a real capture change or manual rerun', () => {
  const lifecycle = new ProbeLifecycle(1, 100);
  lifecycle.beginRequest(request('mic', 1));
  lifecycle.failAttempt('mic', 'failed', 0);
  assert.equal(lifecycle.status(0).phase, 'failed');

  lifecycle.reset();
  assert.deepEqual(lifecycle.status(0), {
    active: false,
    phase: 'idle',
    attempts: { mic: 0, backing: 0 },
    maxAttempts: 1,
    error: null,
  });
  assert.equal(lifecycle.canStart('mic', 0), true);
});
