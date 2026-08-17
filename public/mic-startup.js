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
