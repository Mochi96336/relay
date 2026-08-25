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
    drain(limit = 100) {
      let count = 0;
      while (count < limit && this.runNext()) count += 1;
      return count;
    },
    pending() {
      return tasks.size;
    },
  };
}

function manualEventTarget() {
  const listeners = new Map<string, Set<(event: { detail?: unknown }) => void>>();
  return {
    addEventListener(type: string, listener: (event: { detail?: unknown }) => void) {
      const bucket = listeners.get(type) ?? new Set();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: (event: { detail?: unknown }) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, detail?: unknown) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ detail });
    },
    count(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

const iphoneNavigator = {
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Version/18.6 Mobile/15E148 Safari/604.1',
  platform: 'iPhone',
  maxTouchPoints: 5,
};

test('readiness timeout parks the lifecycle obligation instead of completing it', async () => {
  const timers = manualTimers();
  const events = manualEventTarget();
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
    eligibilityTarget: events,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    settleMs: 0,
    readinessWindowMs: 100,
    readinessPollMs: 50,
  });
  const options = { context, isEligible: () => eligible };

  assert.equal(recovery.schedule('post-mic:late-owner-clear', options), true);
  assert.equal(timers.drain(), 3, 'settle + two bounded readiness samples');
  assert.equal(timers.pending(), 0, 'timeout must stop polling completely');
  assert.equal(suspendCalls, 0);
  assert.equal(events.count('relay-listen-state'), 1,
    'an exhausted boundary must retain exactly one event-driven obligation');
  assert.equal(recovery.schedule('post-mic:late-owner-clear', options), false,
    'the parked boundary remains owned instead of being rescheduled as a new boundary');

  eligible = true;
  events.dispatch('relay-listen-state', { muted: false, audioReady: true });
  assert.equal(suspendCalls, 1,
    'authoritative eligibility recovery must consume the parked destination kick');
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
  assert.equal(context.state, 'running');
  assert.equal(events.count('relay-listen-state'), 0,
    'the eligibility listener must be removed after the obligation completes');
  assert.equal(recovery.schedule('post-mic:late-owner-clear', options), false,
    'a consumed lifecycle boundary remains idempotently completed');
});

test('ineligible Listen state events do not restart polling or consume the owed kick', async () => {
  const timers = manualTimers();
  const events = manualEventTarget();
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
    eligibilityTarget: events,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    settleMs: 0,
    readinessWindowMs: 50,
    readinessPollMs: 50,
  });

  recovery.schedule('foreground:user-muted', { context, isEligible: () => eligible });
  timers.drain();
  assert.equal(timers.pending(), 0);

  events.dispatch('relay-listen-state', { muted: true, audioReady: true });
  events.dispatch('relay-listen-state', { muted: false, audioReady: false });
  assert.equal(timers.pending(), 0,
    'parked recovery must remain event-driven rather than starting another timer window');
  assert.equal(suspendCalls, 0);

  eligible = true;
  events.dispatch('relay-listen-state', { muted: false, audioReady: true });
  assert.equal(suspendCalls, 1);
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
});

test('background cancellation discards a parked obligation and removes its listener', () => {
  const timers = manualTimers();
  const events = manualEventTarget();
  let eligible = false;
  let suspendCalls = 0;
  const context = {
    state: 'running',
    suspend() {
      suspendCalls += 1;
      return Promise.resolve();
    },
    resume() {
      return Promise.resolve();
    },
  };
  const recovery = new IosAudioDestinationRecovery({
    navigatorProvider: () => iphoneNavigator,
    eligibilityTarget: events,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    settleMs: 0,
    readinessWindowMs: 50,
    readinessPollMs: 50,
  });

  recovery.schedule('foreground:parked-then-hidden', { context, isEligible: () => eligible });
  timers.drain();
  assert.equal(events.count('relay-listen-state'), 1);

  recovery.cancel();
  assert.equal(events.count('relay-listen-state'), 0);
  eligible = true;
  events.dispatch('relay-listen-state', { muted: false, audioReady: true });
  assert.equal(suspendCalls, 0,
    'explicit lifecycle cancellation must prevent a later state event from reviving the old boundary');
});

test('a newer lifecycle boundary supersedes an older parked obligation', async () => {
  const timers = manualTimers();
  const events = manualEventTarget();
  let oldEligible = false;
  let newEligible = true;
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
    eligibilityTarget: events,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    settleMs: 0,
    readinessWindowMs: 50,
    readinessPollMs: 50,
  });

  recovery.schedule('foreground:old', { context, isEligible: () => oldEligible });
  timers.drain();
  assert.equal(events.count('relay-listen-state'), 1);

  assert.equal(recovery.schedule('post-mic:new', {
    context,
    isEligible: () => newEligible,
  }), true);
  assert.equal(events.count('relay-listen-state'), 0,
    'superseding a parked boundary must detach its eligibility listener');
  timers.runNext();
  assert.equal(suspendCalls, 1);
  await Promise.resolve();
  assert.equal(resumeCalls, 1);
});
