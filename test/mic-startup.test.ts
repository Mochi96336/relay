import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIC_STARTUP_TIMEOUT_MS,
  MicStartupGate,
} from '../public/mic-startup.js';

function fakeTimers() {
  let callback: (() => void) | null = null;
  let cleared = 0;
  return {
    setTimer(fn: () => void) {
      callback = fn;
      return 1;
    },
    clearTimer() {
      cleared += 1;
    },
    fire() {
      assert.ok(callback, 'startup deadline should be armed');
      callback();
    },
    cleared() {
      return cleared;
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('Mic startup has one explicit handset deadline and disposes a late permission result', async () => {
  assert.equal(MIC_STARTUP_TIMEOUT_MS, 20_000);
  const timers = fakeTimers();
  const gate = new MicStartupGate({
    timeoutMs: MIC_STARTUP_TIMEOUT_MS,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  let resolveCapture: (value: { stopped: boolean }) => void = () => {};
  const capture = new Promise<{ stopped: boolean }>((resolve) => {
    resolveCapture = resolve;
  });
  const stream = { stopped: false };
  const attempt = gate.begin();
  const waiting = gate.wait(attempt, capture, {
    stage: 'waiting for microphone permission',
    dispose: (late) => { late.stopped = true; },
  });

  timers.fire();
  await assert.rejects(
    waiting,
    (error: any) => error?.code === 'mic-startup-timeout'
      && /waiting for microphone permission/.test(error.message),
  );

  resolveCapture(stream);
  await flushPromises();
  assert.equal(stream.stopped, true, 'a permission result that arrives after timeout must be discarded');
});

test('a newer Mic start cancels the older attempt and its late stream cannot resurrect capture', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });

  let resolveOld: (value: { stopped: boolean }) => void = () => {};
  const oldCapture = new Promise<{ stopped: boolean }>((resolve) => {
    resolveOld = resolve;
  });
  const oldStream = { stopped: false };
  const oldAttempt = gate.begin();
  const oldWaiting = gate.wait(oldAttempt, oldCapture, {
    stage: 'waiting for microphone permission',
    dispose: (late) => { late.stopped = true; },
  });

  const newAttempt = gate.begin();
  await assert.rejects(oldWaiting, (error: any) => error?.code === 'mic-startup-cancelled');
  assert.equal(gate.isCurrent(newAttempt), true);

  resolveOld(oldStream);
  await flushPromises();
  assert.equal(oldStream.stopped, true);
  assert.equal(gate.complete(newAttempt), true);
});

test('a successful startup clears its deadline without disposing the adopted resource', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const stream = { stopped: false };
  const attempt = gate.begin();
  const adopted = await gate.wait(attempt, Promise.resolve(stream), {
    stage: 'waiting for microphone permission',
    dispose: (late) => { late.stopped = true; },
  });

  assert.equal(adopted, stream);
  assert.equal(gate.complete(attempt), true);
  assert.equal(stream.stopped, false);
  assert.equal(timers.cleared(), 1);
});

/**
 * The gate stores its timers on the instance and then calls them as
 * `this.setTimer(...)`, which hands the native timer a receiver that is not the
 * window. Chrome tolerates that; Safari and Firefox throw "can only call
 * window.setTimeout on instances of window" - from inside the microphone start
 * path, so a healthy phone reports that its microphone is unavailable.
 *
 * Node does not enforce the receiver, so the browser rule is simulated here.
 * Every other test injects fakes, which is exactly why this went unnoticed.
 */
test('does not hand the native timers a receiver they will refuse', () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let refusals = 0;

  // A timer as strict about its receiver as the browsers' are.
  globalThis.setTimeout = function strictSetTimeout(this: unknown, ...args: unknown[]) {
    if (this !== globalThis) {
      refusals += 1;
      throw new TypeError('can only call window.setTimeout on instances of window');
    }
    return (realSetTimeout as (...a: unknown[]) => unknown)(...args);
  } as typeof globalThis.setTimeout;
  globalThis.clearTimeout = function strictClearTimeout(this: unknown, ...args: unknown[]) {
    if (this !== globalThis) {
      refusals += 1;
      throw new TypeError('can only call window.clearTimeout on instances of window');
    }
    return (realClearTimeout as (...a: unknown[]) => unknown)(...args);
  } as typeof globalThis.clearTimeout;

  try {
    const gate = new MicStartupGate();
    const attempt = gate.begin();
    gate.cancel(attempt);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }

  assert.equal(refusals, 0, 'the gate called a native timer with itself as the receiver');
});
