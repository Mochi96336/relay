import assert from 'node:assert/strict';
import test from 'node:test';

// @ts-expect-error Production browser helpers intentionally ship as plain JS.
import { IosAudioDestinationRecovery, isIosAudioPlatform } from '../public/ios-audio-destination-recovery.js';

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
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const iphoneNavigator = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

test('iOS detection includes iPhone and iPadOS but excludes desktop Mac', () => {
  assert.equal(isIosAudioPlatform(iphoneNavigator), true);
  assert.equal(isIosAudioPlatform({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  }), true);
  assert.equal(isIosAudioPlatform({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  }), false);
});

test('desktop browsers never schedule an AudioDestination kick', () => {
  const timers = manualTimers();
  const recovery = new IosAudioDestinationRecovery({
    navigatorProvider: () => ({ userAgent: 'Desktop Chrome', platform: 'Linux x86_64', maxTouchPoints: 0 }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });

  const scheduled = recovery.schedule('foreground:1', {
    context: { state: 'running' },
    isEligible: () => true,
  });
  assert.equal(scheduled, false);
  assert.equal(timers.pending(), 0);
});

test('one iOS lifecycle boundary performs one settled suspend-resume destination restart', async () => {
  const timers = manualTimers();
  let suspendCalls = 0;
  let resumeCalls = 0;
  const context = {
    state: 'running',
    suspend() {
      suspendCalls += 1;
      context.state = 'suspended';
      return Promise.resolve();
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
  const options = { context, isEligible: () => true };

  assert.equal(recovery.schedule('foreground:2', options), true);
  assert.equal(recovery.schedule('foreground:2', options), false);
  assert.equal(suspendCalls, 0);
  assert.equal(timers.runNext(), true);
  assert.equal(suspendCalls, 1);
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
  assert.equal(context.state, 'running');
  assert.equal(timers.pending(), 0);
  assert.equal(recovery.schedule('foreground:2', options), false);
});

test('post-Mic ownership may clear after the initial 100 ms settle sample', async () => {
  const timers = manualTimers();
  let eligible = false;
  let suspendCalls = 0;
  let resumeCalls = 0;
  const context = {
    state: 'running',
    suspend() {
      suspendCalls += 1;
      context.state = 'suspended';
      return Promise.resolve();
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

  assert.equal(recovery.schedule('post-mic:delayed-owner', {
    context,
    isEligible: () => eligible,
  }), true);
  assert.equal(timers.runNext(), true, 'initial settle sample');
  assert.equal(suspendCalls, 0);
  assert.equal(timers.pending(), 1, 'the same boundary must remain armed inside its readiness window');

  eligible = true;
  assert.equal(timers.runNext(), true, 'readiness retry');
  assert.equal(suspendCalls, 1);
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
  assert.equal(timers.pending(), 0);
});

test('foreground context may become running after the initial settle sample', async () => {
  const timers = manualTimers();
  let suspendCalls = 0;
  let resumeCalls = 0;
  const context = {
    state: 'suspended',
    suspend() {
      suspendCalls += 1;
      context.state = 'suspended';
      return Promise.resolve();
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

  assert.equal(recovery.schedule('foreground:slow-running', {
    context,
    isEligible: () => true,
  }), true);
  timers.runNext();
  assert.equal(suspendCalls, 0);
  assert.equal(timers.pending(), 1);

  context.state = 'running';
  timers.runNext();
  assert.equal(suspendCalls, 1);
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
});

test('readiness retries are bounded when a lifecycle boundary never becomes kickable', () => {
  const timers = manualTimers();
  let suspendCalls = 0;
  const context = {
    state: 'suspended',
    suspend() {
      suspendCalls += 1;
      return Promise.resolve();
    },
  };
  const recovery = new IosAudioDestinationRecovery({
    navigatorProvider: () => iphoneNavigator,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    readinessWindowMs: 100,
    readinessPollMs: 50,
  });
  const options = { context, isEligible: () => true };

  assert.equal(recovery.schedule('foreground:bounded-wait', options), true);
  assert.equal(timers.runNext(), true, 'initial settle sample');
  assert.equal(timers.runNext(), true, 'first readiness retry');
  assert.equal(timers.runNext(), true, 'final readiness deadline');
  assert.equal(timers.pending(), 0);
  assert.equal(suspendCalls, 0);
  assert.equal(recovery.schedule('foreground:bounded-wait', options), false,
    'an exhausted lifecycle boundary must not retry forever');
});

test('a newer lifecycle boundary supersedes an older pending readiness wait', async () => {
  const timers = manualTimers();
  let suspendCalls = 0;
  let resumeCalls = 0;
  const context = {
    state: 'suspended',
    suspend() {
      suspendCalls += 1;
      context.state = 'suspended';
      return Promise.resolve();
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
  const options = { context, isEligible: () => true };

  assert.equal(recovery.schedule('foreground:3', options), true);
  assert.equal(recovery.schedule('post-mic:1', options), true);
  assert.equal(timers.pending(), 1);
  context.state = 'running';
  timers.runNext();
  await Promise.resolve();
  assert.equal(suspendCalls, 1);
  assert.equal(resumeCalls, 1);
});

test('an in-flight destination restart cannot lose its bounded resume to a newer boundary', () => {
  const timers = manualTimers();
  let suspendCalls = 0;
  let resumeCalls = 0;
  const never = new Promise<void>(() => {});
  const context = {
    state: 'running',
    suspend() {
      suspendCalls += 1;
      context.state = 'suspended';
      return never;
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
  const options = { context, isEligible: () => true };

  assert.equal(recovery.schedule('foreground:in-flight', options), true);
  timers.runNext();
  assert.equal(suspendCalls, 1);
  assert.equal(context.state, 'suspended');
  assert.equal(recovery.schedule('post-mic:during-in-flight', options), false);
  assert.equal(timers.pending(), 1, 'the original bounded resume fallback must remain armed');
  timers.runNext();
  assert.equal(resumeCalls, 1);
  assert.equal(context.state, 'running');
});

test('eligibility is rechecked before touching the destination and may recover inside the window', async () => {
  const timers = manualTimers();
  let eligible = true;
  let suspendCalls = 0;
  let resumeCalls = 0;
  const context = {
    state: 'running',
    suspend() {
      suspendCalls += 1;
      context.state = 'suspended';
      return Promise.resolve();
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

  assert.equal(recovery.schedule('foreground:4', {
    context,
    isEligible: () => eligible,
  }), true);
  eligible = false;
  timers.runNext();
  assert.equal(suspendCalls, 0);
  assert.equal(timers.pending(), 1);

  eligible = true;
  timers.runNext();
  assert.equal(suspendCalls, 1);
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
});

test('eligibility changes after native suspend cannot suppress the matching resume', async () => {
  const timers = manualTimers();
  const suspension = deferred<void>();
  let eligible = true;
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

  recovery.schedule('post-mic:mute-after-suspend', { context, isEligible: () => eligible });
  timers.runNext();
  assert.equal(context.state, 'suspended');
  eligible = false;
  suspension.resolve();
  await Promise.resolve();
  assert.equal(resumeCalls, 1,
    'once suspend touched AudioDestination, changing ownership/mute cannot strand that context suspended');
  assert.equal(context.state, 'running');
  assert.equal(timers.pending(), 0);
});

test('a stalled suspend promise gets one bounded resume even if eligibility changes afterward', () => {
  const timers = manualTimers();
  let eligible = true;
  let resumeCalls = 0;
  const never = new Promise<void>(() => {});
  const context = {
    state: 'running',
    suspend() {
      context.state = 'suspended';
      return never;
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

  assert.equal(recovery.schedule('post-mic:2', { context, isEligible: () => eligible }), true);
  timers.runNext();
  assert.equal(context.state, 'suspended');
  eligible = false;
  assert.equal(resumeCalls, 0);
  timers.runNext();
  assert.equal(resumeCalls, 1);
  assert.equal(context.state, 'running');
  assert.equal(timers.pending(), 0);
});

test('explicit lifecycle cancellation may stop an in-flight resume fallback', () => {
  const timers = manualTimers();
  let resumeCalls = 0;
  const never = new Promise<void>(() => {});
  const context = {
    state: 'running',
    suspend() {
      context.state = 'suspended';
      return never;
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

  recovery.schedule('foreground:cancelled-by-background', { context, isEligible: () => true });
  timers.runNext();
  assert.equal(context.state, 'suspended');
  recovery.cancel();
  assert.equal(timers.pending(), 0);
  assert.equal(timers.runNext(), false);
  assert.equal(resumeCalls, 0);
});
