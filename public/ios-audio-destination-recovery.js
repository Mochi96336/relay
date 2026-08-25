const DEFAULT_SETTLE_MS = 100;
const DEFAULT_READINESS_WINDOW_MS = 1_000;
const DEFAULT_READINESS_POLL_MS = 50;
const DEFAULT_RESUME_FALLBACK_MS = 250;
const MAX_COMPLETED_BOUNDARIES = 8;
const LISTEN_STATE_EVENT = 'relay-listen-state';

function currentNavigator() {
  try {
    return globalThis.navigator ?? null;
  } catch {
    return null;
  }
}

function currentWindow() {
  try {
    return globalThis.window ?? null;
  } catch {
    return null;
  }
}

function defaultSetTimeout(callback, delayMs) {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultClearTimeout(timer) {
  globalThis.clearTimeout(timer);
}

function nonNegative(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : fallback;
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, number) : fallback;
}

export function isIosAudioPlatform(navigatorLike = currentNavigator()) {
  const userAgent = String(navigatorLike?.userAgent ?? '');
  const platform = String(navigatorLike?.platform ?? '');
  const uaDataPlatform = String(navigatorLike?.userAgentData?.platform ?? '');
  const maxTouchPoints = Number(navigatorLike?.maxTouchPoints ?? 0);

  return /iPad|iPhone|iPod/i.test(userAgent)
    || /^iOS$/i.test(uaDataPlatform)
    || (platform === 'MacIntel' && maxTouchPoints > 1);
}

export class IosAudioDestinationRecovery {
  constructor({
    navigatorProvider = currentNavigator,
    eligibilityTarget = currentWindow(),
    setTimeoutFn = defaultSetTimeout,
    clearTimeoutFn = defaultClearTimeout,
    settleMs = DEFAULT_SETTLE_MS,
    readinessWindowMs = DEFAULT_READINESS_WINDOW_MS,
    readinessPollMs = DEFAULT_READINESS_POLL_MS,
    resumeFallbackMs = DEFAULT_RESUME_FALLBACK_MS,
  } = {}) {
    this.navigatorProvider = navigatorProvider;
    this.eligibilityTarget = eligibilityTarget;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.settleMs = nonNegative(settleMs, DEFAULT_SETTLE_MS);
    this.readinessWindowMs = nonNegative(readinessWindowMs, DEFAULT_READINESS_WINDOW_MS);
    this.readinessPollMs = positive(readinessPollMs, DEFAULT_READINESS_POLL_MS);
    this.resumeFallbackMs = positive(resumeFallbackMs, DEFAULT_RESUME_FALLBACK_MS);
    this.generation = 0;
    this.pending = null;
    this.completedBoundaries = [];
  }

  schedule(boundaryId, { context, isCurrent = () => true, isEligible }) {
    const key = String(boundaryId ?? '');
    if (
      !key
      || !context
      || typeof isCurrent !== 'function'
      || typeof isEligible !== 'function'
    ) return false;
    if (!isIosAudioPlatform(this.navigatorProvider?.())) return false;
    if (this.completedBoundaries.includes(key) || this.pending?.key === key) return false;
    // Once suspend() has been issued, this physical destination restart owns
    // the stop/start transaction until resume has been requested. A concurrent
    // lifecycle boundary is already covered by that restart and must not cancel
    // its bounded resume fallback.
    if (this.pending?.suspendStarted === true) return false;

    // The initial delay lets AudioSession / foreground state begin settling. The
    // readiness window is bounded, but the lifecycle obligation is not. If the
    // window expires while playback is temporarily ineligible, the token parks
    // without polling and waits for Listen to publish a later eligible state.
    this.#cancelPending();
    const token = {
      key,
      context,
      isCurrent,
      isEligible,
      generation: ++this.generation,
      timer: null,
      resumeTimer: null,
      eligibilityListener: null,
      readinessRemainingMs: this.readinessWindowMs,
      suspendStarted: false,
      parked: false,
      finished: false,
    };
    token.timer = this.setTimeoutFn(() => this.#seekReady(token), this.settleMs);
    this.pending = token;
    return true;
  }

  retry() {
    const token = this.pending;
    if (
      !token
      || token.finished
      || token.suspendStarted
      || token.timer !== null
      || token.parked !== true
    ) return false;

    if (!this.#transactionValid(token)) {
      this.#finish(token);
      return false;
    }
    if (!this.#ready(token)) return false;

    this.#detachEligibilityListener(token);
    token.parked = false;
    this.#beginKick(token);
    return true;
  }

  cancel() {
    this.generation += 1;
    this.#cancelPending();
  }

  #predicate(predicate) {
    try {
      return predicate() === true;
    } catch {
      return false;
    }
  }

  #transactionValid(token) {
    return this.pending === token
      && token.generation === this.generation
      && token.context?.state !== 'closed'
      && this.#predicate(token.isCurrent);
  }

  #ready(token) {
    return this.#transactionValid(token)
      && token.context.state === 'running'
      && this.#predicate(token.isEligible);
  }

  #seekReady(token) {
    token.timer = null;
    if (!this.#transactionValid(token)) {
      this.#finish(token);
      return;
    }
    if (this.#ready(token)) {
      this.#beginKick(token);
      return;
    }
    if (token.readinessRemainingMs <= 0) {
      this.#park(token);
      return;
    }

    const delayMs = Math.min(this.readinessPollMs, token.readinessRemainingMs);
    token.readinessRemainingMs -= delayMs;
    token.timer = this.setTimeoutFn(() => this.#seekReady(token), delayMs);
  }

  #park(token) {
    if (!this.#transactionValid(token)) {
      this.#finish(token);
      return;
    }
    token.parked = true;
    if (
      token.eligibilityListener
      || typeof this.eligibilityTarget?.addEventListener !== 'function'
    ) return;

    token.eligibilityListener = (event) => {
      const detail = event?.detail;
      if (detail?.muted !== false || detail?.audioReady !== true) return;
      this.retry();
    };
    this.eligibilityTarget.addEventListener(LISTEN_STATE_EVENT, token.eligibilityListener);
  }

  #beginKick(token) {
    if (!this.#ready(token)) {
      if (token.parked) return;
      this.#seekReady(token);
      return;
    }

    let resumeRequested = false;
    const requestResume = () => {
      if (resumeRequested) return;
      // Eligibility is intentionally not rechecked here. Once suspend() has
      // touched AudioDestination, this transaction owes the same current
      // context one matching resume unless an explicit lifecycle cancel
      // (pagehide/background) or graph replacement invalidated the token.
      if (!this.#transactionValid(token)) {
        this.#finish(token);
        return;
      }
      resumeRequested = true;
      if (token.resumeTimer !== null) {
        this.clearTimeoutFn(token.resumeTimer);
        token.resumeTimer = null;
      }
      try {
        const pending = token.context.resume();
        pending?.catch?.(() => {});
      } catch {}
      this.#finish(token);
    };

    token.suspendStarted = true;
    try {
      const suspended = token.context.suspend();
      token.resumeTimer = this.setTimeoutFn(requestResume, this.resumeFallbackMs);
      Promise.resolve(suspended).then(requestResume, requestResume);
    } catch {
      requestResume();
    }
  }

  #detachEligibilityListener(token) {
    if (!token?.eligibilityListener) return;
    try {
      this.eligibilityTarget?.removeEventListener?.(
        LISTEN_STATE_EVENT,
        token.eligibilityListener,
      );
    } catch {}
    token.eligibilityListener = null;
  }

  #rememberBoundary(key) {
    this.completedBoundaries.push(key);
    const overflow = this.completedBoundaries.length - MAX_COMPLETED_BOUNDARIES;
    if (overflow > 0) this.completedBoundaries.splice(0, overflow);
  }

  #finish(token) {
    if (token.finished) return;
    token.finished = true;
    if (token.timer !== null) this.clearTimeoutFn(token.timer);
    if (token.resumeTimer !== null) this.clearTimeoutFn(token.resumeTimer);
    this.#detachEligibilityListener(token);
    token.timer = null;
    token.resumeTimer = null;
    token.parked = false;
    if (this.pending === token) this.pending = null;
    this.#rememberBoundary(token.key);
  }

  #cancelPending() {
    const token = this.pending;
    if (!token) return;
    if (token.timer !== null) this.clearTimeoutFn(token.timer);
    if (token.resumeTimer !== null) this.clearTimeoutFn(token.resumeTimer);
    this.#detachEligibilityListener(token);
    token.timer = null;
    token.resumeTimer = null;
    token.parked = false;
    token.finished = true;
    this.pending = null;
  }
}
