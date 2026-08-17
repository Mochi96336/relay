export type ProbeTarget = 'mic' | 'backing';
export type ProbePhase =
  | 'idle'
  | 'mic-requested'
  | 'mic-analyzing'
  | 'mic-retry-wait'
  | 'backing-waiting'
  | 'backing-requested'
  | 'backing-analyzing'
  | 'backing-retry-wait'
  | 'failed';

export type ProbeFailure = {
  target: ProbeTarget;
  message: string;
};

export type ProbeRequest<TGeneration = number | null> = {
  target: ProbeTarget;
  requestId: number;
  serverSentAtMs: number;
  sessionGeneration: number;
  generation: TGeneration;
};

export type ProbeAnalysis<TGeneration = number | null> = {
  target: ProbeTarget;
  targetSample: number;
  windowStart: number;
  windowSamples: number;
  sessionGeneration: number;
  generation: TGeneration;
  deadlineMs: number;
};

export type ProbeLifecycleStatus = {
  active: boolean;
  phase: ProbePhase;
  attempts: Record<ProbeTarget, number>;
  maxAttempts: number;
  error: string | null;
};

/**
 * Owns only the retry/request state for boot probe calibration.
 *
 * AudioSession still owns PCM history and the server still owns the measured
 * leg values. Keeping those domains separate matters: a failed backing attempt
 * may retry without throwing away a valid Mic measurement, while a real capture
 * generation change can still reset the whole run at the server boundary.
 */
export class ProbeLifecycle {
  private request: ProbeRequest | null = null;
  private analysis: ProbeAnalysis | null = null;
  private readonly attemptCounts: Record<ProbeTarget, number> = { mic: 0, backing: 0 };
  private readonly retryAfterMs: Record<ProbeTarget, number> = { mic: -Infinity, backing: -Infinity };
  private failure: ProbeFailure | null = null;
  private micMeasured = false;

  constructor(
    readonly maxAttempts: number,
    readonly retryMs: number,
  ) {
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('Probe maxAttempts must be a positive integer.');
    }
    if (!Number.isFinite(retryMs) || retryMs < 0) {
      throw new Error('Probe retryMs must be non-negative.');
    }
  }

  reset() {
    this.request = null;
    this.analysis = null;
    this.attemptCounts.mic = 0;
    this.attemptCounts.backing = 0;
    this.retryAfterMs.mic = -Infinity;
    this.retryAfterMs.backing = -Infinity;
    this.failure = null;
    this.micMeasured = false;
  }

  setMicMeasured(measured: boolean) {
    this.micMeasured = measured;
  }

  get pendingRequest() {
    return this.request;
  }

  get pendingAnalysis() {
    return this.analysis;
  }

  beginRequest(request: ProbeRequest) {
    if (this.failure || this.request || this.analysis) return false;
    if (this.attemptCounts[request.target] >= this.maxAttempts) return false;
    this.attemptCounts[request.target] += 1;
    this.request = request;
    return true;
  }

  /**
   * A reply only owns the request with the same id. A stale reply is a no-op;
   * critically, it cannot clear a newer request before the id check happens.
   */
  acceptReply(requestId: unknown) {
    if (!this.request || Number(requestId) !== this.request.requestId) return null;
    const request = this.request;
    this.request = null;
    return request;
  }

  /**
   * Browser acknowledgements also have to prove the capture generation for the
   * phone-mic leg before they are allowed to consume the pending request.
   *
   * The backing probe is played by the robot page but captured by backing:stdin,
   * so that page intentionally has no capture generation to report; the server
   * validates its own backing generation separately.
   */
  acceptClientReply(requestId: unknown, generation: unknown) {
    const request = this.request;
    if (!request || Number(requestId) !== request.requestId) return null;
    if (
      request.target === 'mic'
      && (Number(generation) >>> 0) !== (Number(request.generation) >>> 0)
    ) {
      return null;
    }
    return this.acceptReply(requestId);
  }

  beginAnalysis(analysis: ProbeAnalysis) {
    if (this.failure || this.analysis) return false;
    this.analysis = analysis;
    return true;
  }

  takeAnalysis() {
    const analysis = this.analysis;
    this.analysis = null;
    return analysis;
  }

  canStart(target: ProbeTarget, nowMs: number) {
    return !this.failure
      && !this.request
      && !this.analysis
      && this.attemptCounts[target] < this.maxAttempts
      && nowMs >= this.retryAfterMs[target];
  }

  failAttempt(target: ProbeTarget, reason: string, nowMs: number) {
    if (this.request?.target === target) this.request = null;
    if (this.analysis?.target === target) this.analysis = null;
    this.retryAfterMs[target] = nowMs + this.retryMs;

    if (this.attemptCounts[target] < this.maxAttempts) return null;

    const label = target === 'mic' ? 'Phone microphone' : 'Song source';
    const message = `${label} timing probe failed after ${this.attemptCounts[target]} attempts: ${reason}`;
    this.failure = { target, message };
    return this.failure;
  }

  status(nowMs: number): ProbeLifecycleStatus {
    let phase: ProbePhase = 'idle';
    if (this.failure) phase = 'failed';
    else if (this.request) phase = `${this.request.target}-requested`;
    else if (this.analysis) phase = `${this.analysis.target}-analyzing`;
    else if (this.micMeasured) {
      phase = nowMs < this.retryAfterMs.backing ? 'backing-retry-wait' : 'backing-waiting';
    } else if (this.attemptCounts.mic > 0 && nowMs < this.retryAfterMs.mic) {
      phase = 'mic-retry-wait';
    }

    const hasStarted = this.attemptCounts.mic > 0 || this.attemptCounts.backing > 0 || this.micMeasured;
    return {
      active: this.failure === null && hasStarted,
      phase,
      attempts: { ...this.attemptCounts },
      maxAttempts: this.maxAttempts,
      error: this.failure?.message ?? null,
    };
  }
}
