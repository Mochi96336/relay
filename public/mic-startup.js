export const MIC_STARTUP_TIMEOUT_MS = 20_000;

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
 * microphone after a retry or Release. Prepared resources remain owned by the
 * attempt until complete() transfers them; cancel/dispose releases only that
 * attempt's resources, never a newer session's global state.
 */
export class MicStartupGate {
  constructor({
    timeoutMs = MIC_STARTUP_TIMEOUT_MS,
    // Bound, because these are stored on the instance and then called as
    // `this.setTimer(...)`. That hands the timer `this` = the gate, and the
    // native timers refuse a receiver that is not the window: Chrome tolerates
    // it, Safari and Firefox throw "can only call window.setTimeout on
    // instances of window" - from inside the microphone start path, which is
    // how a healthy phone ends up reporting that its microphone is
    // unavailable. An injected fake is a plain function and does not care.
    setTimer = globalThis.setTimeout.bind(globalThis),
    clearTimer = globalThis.clearTimeout.bind(globalThis),
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
      disposers: [],
      disposals: [],
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
    for (const dispose of attempt.disposers) void dispose();
    attempt.disposers = [];
    return true;
  }

  /** Transfer every prepared resource to the active session in one step. */
  complete(attempt) {
    if (!this.isCurrent(attempt)) return false;
    this.current = null;
    if (attempt.timer !== null) this.clearTimer(attempt.timer);
    attempt.timer = null;
    attempt.disposers = [];
    return true;
  }

  /** Own a synchronously created resource until complete transfers it. */
  own(attempt, value, dispose) {
    const release = this.#disposer(attempt, value, dispose);
    if (!this.isCurrent(attempt)) {
      void release();
      throw new MicStartupCancelledError();
    }
    attempt.disposers.push(release);
    return value;
  }

  /** Roll back this attempt only; never wait on unresolved browser permission. */
  async dispose(attempt) {
    this.cancel(attempt);
    await Promise.all(attempt.disposals);
  }

  #disposer(attempt, value, dispose) {
    let pending = null;
    return () => {
      if (!pending) {
        pending = Promise.resolve().then(() => dispose(value)).catch(() => {});
        attempt.disposals.push(pending);
      }
      return pending;
    };
  }

  async wait(attempt, operation, { stage, dispose } = {}) {
    if (stage && this.isCurrent(attempt)) attempt.stage = stage;

    // Both the late-result observer and the race continuation can see the
    // same cancelled resource. Share cleanup ownership before either runs.
    let release = null;
    const disposeOnce = (value) => {
      if (typeof dispose !== 'function') return;
      release ??= this.#disposer(attempt, value, dispose);
      return release();
    };
    const pending = Promise.resolve(operation);
    pending.then(
      (value) => {
        if (this.isCurrent(attempt) || typeof dispose !== 'function') return;
        return disposeOnce(value);
      },
      () => {},
    );

    if (!this.isCurrent(attempt)) throw new MicStartupCancelledError();
    const value = await Promise.race([pending, attempt.cancelled]);
    if (!this.isCurrent(attempt)) {
      await disposeOnce(value);
      throw new MicStartupCancelledError();
    }
    if (typeof dispose === 'function') attempt.disposers.push(() => disposeOnce(value));
    return value;
  }
}
