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

test('cancelling an already-resolved resource before adoption disposes it exactly once', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const attempt = gate.begin();
  const resource = {};
  let disposals = 0;
  const waiting = gate.wait(attempt, Promise.resolve(resource), {
    dispose: value => { assert.equal(value, resource); disposals += 1; },
  });
  gate.cancel(attempt);
  await assert.rejects(waiting, (error: any) => error?.code === 'mic-startup-cancelled');
  await flushPromises();
  assert.equal(disposals, 1);
});

for (const failure of ['throw', 'reject']) {
  test(`cleanup ${failure} preserves cancellation and does not retry disposal`, async () => {
    const timers = fakeTimers();
    const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
    const attempt = gate.begin();
    let disposals = 0;
    const waiting = gate.wait(attempt, Promise.resolve({}), {
      dispose: () => {
        disposals += 1;
        if (failure === 'throw') throw new Error('cleanup failed');
        return Promise.reject(new Error('cleanup failed'));
      },
    });
    gate.cancel(attempt);
    await assert.rejects(waiting, (error: any) => error?.code === 'mic-startup-cancelled');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disposals, 1);
  });
}

test('failed preparation releases every acquired resource once, despite a cleanup error', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const attempt = gate.begin();
  const released: string[] = [];
  await gate.wait(attempt, Promise.resolve({}), { dispose: () => { released.push('stream'); } });
  gate.own(attempt, {}, () => { released.push('encoder'); throw new Error('encoder cleanup failed'); });
  gate.own(attempt, {}, async () => { released.push('context'); });
  await assert.rejects(gate.wait(attempt, Promise.reject(new Error('worklet unavailable'))), /worklet unavailable/);
  await gate.dispose(attempt);
  await gate.dispose(attempt);
  assert.deepEqual(released, ['stream', 'encoder', 'context']);
});

test('complete transfers all prepared resources and later attempt cleanup cannot release them', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const attempt = gate.begin();
  let closed = 0;
  gate.own(attempt, {}, () => { closed++; });
  await gate.wait(attempt, Promise.resolve({}), { dispose: () => { closed++; } });
  assert.equal(gate.complete(attempt), true);
  await gate.dispose(attempt);
  const next = gate.begin();
  await gate.dispose(next);
  assert.equal(closed, 0);
});

test('an older asynchronous cleanup cannot cancel or dispose a newer start', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let finishClose!: () => void;
  const closing = new Promise<void>((resolve) => { finishClose = resolve; });
  const old = gate.begin();
  gate.own(old, {}, () => closing);
  const oldCleanup = gate.dispose(old);
  const next = gate.begin();
  let nextClosed = false;
  gate.own(next, {}, () => { nextClosed = true; });
  finishClose();
  await oldCleanup;
  assert.equal(gate.isCurrent(next), true);
  assert.equal(nextClosed, false);
  gate.complete(next);
});

test('rollback does not wait for an unresolved browser operation but still disposes its late resource', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  let resolveLate!: (value: object) => void;
  const operation = new Promise<object>((resolve) => { resolveLate = resolve; });
  const attempt = gate.begin();
  let closed = 0;
  gate.own(attempt, {}, () => { closed++; });
  const waiting = gate.wait(attempt, operation, { dispose: () => { closed++; } });
  const rejected = assert.rejects(waiting, (error: any) => error.code === 'mic-startup-cancelled');
  await gate.dispose(attempt);
  await rejected;
  assert.equal(closed, 1);
  resolveLate({});
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, 2);
});

test('a resource operation reaching an already-cancelled attempt is still retired when it resolves', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const attempt = gate.begin();
  gate.cancel(attempt);
  let closed = 0;
  await assert.rejects(gate.wait(attempt, Promise.resolve({}), { dispose: () => { closed++; } }),
    (error: any) => error.code === 'mic-startup-cancelled');
  await gate.dispose(attempt);
  assert.equal(closed, 1);
});

test('a synchronously created resource cannot be attached to a retired attempt', async () => {
  const timers = fakeTimers();
  const gate = new MicStartupGate({ setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const attempt = gate.begin();
  gate.cancel(attempt);
  let closed = 0;
  assert.throws(() => gate.own(attempt, {}, () => { closed++; }),
    (error: any) => error.code === 'mic-startup-cancelled');
  await gate.dispose(attempt);
  assert.equal(closed, 1);
});
