import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error Production browser helpers intentionally ship as plain JS.
import { IosAudioDestinationRecovery } from '../public/ios-audio-destination-recovery.js';

function manualTimers() {
  let nextId = 1;
  const tasks = new Map<number, () => void>();
  return {
    setTimeoutFn(callback: () => void) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, callback);
      return id;
    },
    clearTimeoutFn(id: number) {
      tasks.delete(id);
    },
    runNext() {
      const entry = tasks.entries().next().value as [number, () => void] | undefined;
      if (!entry) return false;
      const [id, callback] = entry;
      tasks.delete(id);
      callback();
      return true;
    },
    pending() {
      return tasks.size;
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const iphoneNavigator = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

test('a graph replacement before readiness permanently fences the old context', () => {
  const timers = manualTimers();
  let current = true;
  let suspendCalls = 0;
  const context = {
    state: 'running',
    suspend() {
      suspendCalls += 1;
      return Promise.resolve();
    },
  };
  const recovery = new IosAudioDestinationRecovery({
    navigatorProvider: () => iphoneNavigator,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  assert.equal(recovery.schedule('foreground:replaced-before-kick', {
    context,
    isCurrent: () => current,
    isEligible: () => true,
  }), true);
  current = false;
  timers.runNext();
  assert.equal(suspendCalls, 0);
  assert.equal(timers.pending(), 0);
});

test('a graph replacement after native suspend cannot resume a stale context', async () => {
  const timers = manualTimers();
  const suspension = deferred<void>();
  let current = true;
  let resumeCalls = 0;
  const context = {
    state: 'running',
    suspend() {
      context.state = 'suspended';
      return suspension.promise;
    },
    resume() {
      resumeCalls += 1;
      context.state = 'running';
      return Promise.resolve();
    },
  };
  const recovery = new IosAudioDestinationRecovery({
    navigatorProvider: () => iphoneNavigator,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  recovery.schedule('post-mic:replaced-after-suspend', {
    context,
    isCurrent: () => current,
    isEligible: () => true,
  });
  timers.runNext();
  assert.equal(context.state, 'suspended');
  current = false;
  suspension.resolve();
  await Promise.resolve();
  assert.equal(resumeCalls, 0,
    'a replaced AudioContext must not be revived after the current graph has moved on');
  assert.equal(timers.pending(), 0);
});
