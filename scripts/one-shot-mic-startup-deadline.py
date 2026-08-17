from pathlib import Path


def replace_once(path: str, old: str, new: str, label: str):
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: {label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1))


Path('public/mic-startup.js').write_text("""export const MIC_STARTUP_TIMEOUT_MS = 20_000;

export class MicStartupCancelledError extends Error {
  constructor(message = 'Microphone startup was cancelled.') {
    super(message);
    this.name = 'MicStartupCancelledError';
    this.code = 'mic-startup-cancelled';
  }
}

export class MicStartupTimeoutError extends Error {
  constructor(stage) {
    super(`Microphone startup timed out while ${stage}. Dismiss any browser prompt and try again.`);
    this.name = 'MicStartupTimeoutError';
    this.code = 'mic-startup-timeout';
    this.stage = stage;
  }
}

/**
 * Owns the one local microphone-start attempt that is allowed to be pending.
 *
 * Browser permission promises cannot be aborted portably. Cancelling this gate
 * therefore rejects Relay's wait immediately and disposes a late resource when
 * the browser eventually resolves it, so an old prompt can never resurrect a
 * microphone after a retry or Release.
 */
export class MicStartupGate {
  constructor({
    timeoutMs = MIC_STARTUP_TIMEOUT_MS,
    setTimer = globalThis.setTimeout,
    clearTimer = globalThis.clearTimeout,
  } = {}) {
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.sequence = 0;
    this.current = null;
  }

  begin() {
    if (this.current) {
      this.cancel(this.current, new MicStartupCancelledError('A newer microphone start replaced this attempt.'));
    }

    let rejectCancellation;
    const cancelled = new Promise((_, reject) => {
      rejectCancellation = reject;
    });
    // A caller normally races this promise immediately. Keep explicit
    // cancellation safe even in the tiny gap before that wait is installed.
    cancelled.catch(() => {});

    const attempt = {
      id: ++this.sequence,
      stage: 'starting the microphone',
      cancelled,
      rejectCancellation,
      timer: null,
    };
    attempt.timer = this.setTimer(() => {
      this.cancel(attempt, new MicStartupTimeoutError(attempt.stage));
    }, this.timeoutMs);
    this.current = attempt;
    return attempt;
  }

  isCurrent(attempt) {
    return Boolean(attempt) && this.current === attempt;
  }

  cancel(attempt = this.current, reason = new MicStartupCancelledError()) {
    if (!this.isCurrent(attempt)) return false;
    this.current = null;
    if (attempt.timer !== null) this.clearTimer(attempt.timer);
    attempt.timer = null;
    attempt.rejectCancellation(reason);
    return true;
  }

  complete(attempt) {
    if (!this.isCurrent(attempt)) return false;
    this.current = null;
    if (attempt.timer !== null) this.clearTimer(attempt.timer);
    attempt.timer = null;
    return true;
  }

  async wait(attempt, operation, { stage, dispose } = {}) {
    if (!this.isCurrent(attempt)) throw new MicStartupCancelledError();
    if (stage) attempt.stage = stage;

    const pending = Promise.resolve(operation);
    pending.then(
      (value) => {
        if (this.isCurrent(attempt) || typeof dispose !== 'function') return;
        Promise.resolve(dispose(value)).catch(() => {});
      },
      () => {},
    );

    const value = await Promise.race([pending, attempt.cancelled]);
    if (!this.isCurrent(attempt)) {
      if (typeof dispose === 'function') await dispose(value);
      throw new MicStartupCancelledError();
    }
    return value;
  }
}
""")

Path('test/mic-startup.test.ts').write_text("""import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIC_STARTUP_TIMEOUT_MS,
  MicStartupGate,
} from '../public/mic-startup.js';

function fakeTimers() {
  let callback = null;
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
""")

replace_once(
    'public/app.js',
    """import { PreferredAudioTransport } from './audio-transport.js';
""",
    """import { PreferredAudioTransport } from './audio-transport.js';
import { MicStartupCancelledError, MicStartupGate } from './mic-startup.js';
""",
    'import Mic startup gate',
)

replace_once(
    'public/app.js',
    """let activeNode = null;
let publisherActive = false;
let liveMixActive = false;
""",
    """let activeNode = null;
let publisherActive = false;
let publisherStarting = false;
let publisherStartRequest = null;
const micStartup = new MicStartupGate();
let liveMixActive = false;
""",
    'add Mic startup state',
)

replace_once(
    'public/app.js',
    """async function stop(setIdle = true, { releaseMic = true } = {}) {
  clearSocketReconnect();
""",
    """async function stop(setIdle = true, { releaseMic = true } = {}) {
  micStartup.cancel();
  publisherStarting = false;
  clearSocketReconnect();
""",
    'stop cancels pending startup',
)

old_start = """async function startPublisher(takeoverExpectedOwnerId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }
  await stop();
  pendingPublisherTakeoverOwnerId = takeoverExpectedOwnerId;
  setStatus('Starting microphone…');

  // Capture is prepared before the server is allowed to change ownership. A
  // denied permission or failed AudioWorklet therefore leaves the current
  // singer untouched.
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });

  audioContext = new AudioContext({ latencyHint: 'interactive' });
  const captureContext = audioContext;
  captureContext.addEventListener('statechange', () => {
    if (!publisherActive || audioContext !== captureContext || captureContext.state !== 'suspended') return;
    void resumePublisherAudioContext();
  });
  await audioContext.audioWorklet.addModule('/capture-worklet.js');
  await audioContext.resume();

  setPublisherActive(true);
"""
new_start = """async function startPublisher(takeoverExpectedOwnerId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is unavailable. On a phone, open Relay through HTTPS.');
  }

  const startup = micStartup.begin();
  publisherStarting = true;
  publisherButton.disabled = true;
  updateSingerControls();
  pendingPublisherTakeoverOwnerId = takeoverExpectedOwnerId;
  setStatus('Starting microphone…');

  let preparedStream = null;
  let preparedContext = null;
  try {
    // Browser permission promises are not abortable on every supported phone.
    // The gate gives the UI a deadline and stops a stream that resolves after
    // this attempt was cancelled or superseded.
    preparedStream = await micStartup.wait(
      startup,
      navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        video: false,
      }),
      {
        stage: 'waiting for microphone permission',
        dispose: (stream) => stream.getTracks().forEach((track) => track.stop()),
      },
    );

    preparedContext = new AudioContext({ latencyHint: 'interactive' });
    const captureContext = preparedContext;
    captureContext.addEventListener('statechange', () => {
      if (!publisherActive || audioContext !== captureContext || captureContext.state !== 'suspended') return;
      void resumePublisherAudioContext();
    });
    await micStartup.wait(
      startup,
      captureContext.audioWorklet.addModule('/capture-worklet.js'),
      { stage: 'loading the microphone audio processor' },
    );
    await micStartup.wait(
      startup,
      captureContext.resume(),
      { stage: 'starting microphone audio' },
    );
    if (!micStartup.isCurrent(startup)) throw new MicStartupCancelledError();

    mediaStream = preparedStream;
    preparedStream = null;
    audioContext = preparedContext;
    preparedContext = null;
    setPublisherActive(true);
    publisherStarting = false;
    micStartup.complete(startup);
"""
replace_once('public/app.js', old_start, new_start, 'replace unbounded Mic startup preparation')

old_end = """  try {
    await connectPublisherSocket();
  } catch {
    setStatus('Reconnecting microphone…', 'Initial Relay connection failed; retrying automatically.');
    schedulePublisherReconnect();
  }
}

async function requestPublisherStart(takeoverExpectedOwnerId = null) {
  try {
    await startPublisher(takeoverExpectedOwnerId);
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    setStatus('Could not start microphone', message);
    dispatchRelayEvent('relay-microphone-start-failed', {
      message,
      takeoverExpectedOwnerId,
    });
    await stop(false, { releaseMic: false });
  }
}
"""
new_end = """    try {
      await connectPublisherSocket();
    } catch {
      setStatus('Reconnecting microphone…', 'Initial Relay connection failed; retrying automatically.');
      schedulePublisherReconnect();
    }
  } finally {
    if (preparedStream) preparedStream.getTracks().forEach((track) => track.stop());
    if (preparedContext) {
      try {
        await preparedContext.close();
      } catch {}
    }
  }
}

async function requestPublisherStart(takeoverExpectedOwnerId = null) {
  if (publisherStartRequest) return publisherStartRequest;

  const request = (async () => {
    try {
      await stop(false, { releaseMic: true });
      await startPublisher(takeoverExpectedOwnerId);
    } catch (error) {
      if (error?.code === 'mic-startup-cancelled') return;
      console.error(error);
      const message = error instanceof Error ? error.message : String(error);
      setStatus('Could not start microphone', message);
      dispatchRelayEvent('relay-microphone-start-failed', {
        message,
        takeoverExpectedOwnerId,
      });
      await stop(false, { releaseMic: false });
    }
  })();

  publisherStartRequest = request;
  try {
    await request;
  } finally {
    if (publisherStartRequest === request) publisherStartRequest = null;
  }
}
"""
replace_once('public/app.js', old_end, new_end, 'finish startup cleanup and deduplicate requests')

# Pin the integration contract in the existing lifecycle characterization too.
path = Path('test/mic-lifecycle-recovery.test.ts')
text = path.read_text()
anchor = """test('initial Relay connection failure remains cancellable instead of trapping an active Mic', () => {
"""
contract = """test('Mic startup is single-flight, deadline-bound, and disposes late permission capture', () => {
  const startAt = app.indexOf('async function startPublisher');
  const requestAt = app.indexOf('async function requestPublisherStart', startAt);
  assert.ok(startAt >= 0 && requestAt > startAt);
  const startup = app.slice(startAt, requestAt);

  assert.match(app, /const micStartup = new MicStartupGate\(\)/);
  assert.match(startup, /publisherButton\.disabled = true[\s\S]*navigator\.mediaDevices\.getUserMedia/,
    'the button must become single-flight before the permission promise starts');
  assert.match(startup, /micStartup\.wait\([\s\S]*waiting for microphone permission/);
  assert.match(startup, /dispose: \(stream\) => stream\.getTracks\(\)\.forEach\(\(track\) => track\.stop\(\)\)/);
  assert.match(startup, /loading the microphone audio processor/);
  assert.match(startup, /starting microphone audio/);
  assert.match(app, /async function stop[\s\S]*micStartup\.cancel\(\)/,
    'every local stop invalidates an in-flight startup before late browser work can resolve');
  assert.match(app, /if \(publisherStartRequest\) return publisherStartRequest/,
    'duplicate clicks and takeover events must share one startup request');
});

"""
count = text.count(anchor)
if count != 1:
    raise SystemExit(f'test/mic-lifecycle-recovery.test.ts: startup contract anchor count={count}')
path.write_text(text.replace(anchor, contract + anchor, 1))
