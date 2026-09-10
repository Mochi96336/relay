import type { BootCalibrationResult } from './boot-calibration.js';
import {
  ProbeLifecycle,
  type ProbeAnalysis,
  type ProbeFailure,
  type ProbeLifecycleStatus,
  type ProbeRequest,
  type ProbeTarget,
} from './probe-lifecycle.js';

export type BootProbeContext = {
  sessionGeneration: number;
  micGeneration: number | null;
  backingGeneration: number | null;
};

export type BootProbeMicLeg = {
  targetSample: number;
  actualSample: number;
  correlation: number;
  sessionGeneration: number;
  micGeneration: number | null;
};

export type BootProbeRuntimeOptions = {
  maxAttempts: number;
  retryMs: number;
};

type BootProbeMicLegContext = Pick<BootProbeContext, 'sessionGeneration' | 'micGeneration'>;

function micLegMatchesContext(leg: BootProbeMicLeg, context: BootProbeMicLegContext) {
  return leg.sessionGeneration === context.sessionGeneration
    && leg.micGeneration === context.micGeneration;
}

/**
 * Aggregate state for the boot-probe measurement lifecycle.
 *
 * ProbeLifecycle remains the request/retry state machine. This class owns the
 * companion evidence/result state that must reset and survive with that machine
 * as one unit. PCM capture, probe correlation, boot-calibration math, timing
 * authority and application into AudioSession remain outside this aggregate.
 */
export class BootProbeRuntime {
  private readonly lifecycle: ProbeLifecycle;
  private requestSequence = 0;
  private measuredMicLeg: BootProbeMicLeg | null = null;
  private probeCorrelation: Record<ProbeTarget, number | null> = { mic: null, backing: null };
  private completedContext: BootProbeContext | null = null;
  private lastCalibration: BootCalibrationResult | null = null;
  private pathDifference: number | null = null;
  private resultConfidence: number | null = null;

  constructor(options: BootProbeRuntimeOptions) {
    this.lifecycle = new ProbeLifecycle(options.maxAttempts, options.retryMs);
  }

  get pendingAnalysis() {
    return this.lifecycle.pendingAnalysis;
  }

  get lifecycleIdle() {
    return this.lifecycle.idle;
  }

  get micLeg() {
    return this.measuredMicLeg === null ? null : { ...this.measuredMicLeg };
  }

  get hasMicLeg() {
    return this.measuredMicLeg !== null;
  }

  get correlations() {
    return { ...this.probeCorrelation };
  }

  get calibrationResult() {
    return this.lastCalibration === null ? null : { ...this.lastCalibration };
  }

  get pathDifferenceMs() {
    return this.pathDifference;
  }

  get confidence() {
    return this.resultConfidence;
  }

  nextRequestId() {
    this.requestSequence += 1;
    return this.requestSequence;
  }

  status(nowMs: number): ProbeLifecycleStatus {
    return this.lifecycle.status(nowMs);
  }

  beginRequest(request: ProbeRequest) {
    return this.lifecycle.beginRequest(request);
  }

  takeExpiredRequest(nowMs: number, timeoutMs: number) {
    return this.lifecycle.takeExpiredRequest(nowMs, timeoutMs);
  }

  acceptClientReply(requestId: unknown, generation: unknown) {
    return this.lifecycle.acceptClientReply(requestId, generation);
  }

  beginAnalysis(analysis: ProbeAnalysis) {
    return this.lifecycle.beginAnalysis(analysis);
  }

  takeAnalysis() {
    return this.lifecycle.takeAnalysis();
  }

  canStart(target: ProbeTarget, nowMs: number) {
    return this.lifecycle.canStart(target, nowMs);
  }

  failAttempt(target: ProbeTarget, reason: string, nowMs: number): ProbeFailure | null {
    if (target === 'mic') this.clearMicLeg();
    return this.lifecycle.failAttempt(target, reason, nowMs);
  }

  setMicLeg(leg: BootProbeMicLeg) {
    this.measuredMicLeg = { ...leg };
    this.lifecycle.setMicMeasured(true);
  }

  takeMicLegForContext(context: BootProbeMicLegContext) {
    const leg = this.micLeg;
    this.clearMicLeg();
    return leg !== null && micLegMatchesContext(leg, context) ? leg : null;
  }

  micLegStaleForContext(context: BootProbeMicLegContext) {
    return this.measuredMicLeg !== null
      && !micLegMatchesContext(this.measuredMicLeg, context);
  }

  completedContextMatches(context: BootProbeContext) {
    return this.completedContext !== null
      && this.completedContext.sessionGeneration === context.sessionGeneration
      && this.completedContext.micGeneration === context.micGeneration
      && this.completedContext.backingGeneration === context.backingGeneration;
  }

  noteCorrelation(target: ProbeTarget, correlation: number) {
    this.probeCorrelation = { ...this.probeCorrelation, [target]: correlation };
  }

  resetCorrelations() {
    this.probeCorrelation = { mic: null, backing: null };
  }

  recordCalibration(context: BootProbeContext, result: BootCalibrationResult) {
    this.completedContext = { ...context };
    this.lastCalibration = { ...result };
    this.pathDifference = result.micLatencyMs - result.backingLatencyMs;
    this.resultConfidence = result.confidence;
  }

  reapplyCalibration(advanceMs: number, deltaMs: number) {
    if (this.lastCalibration === null) return null;
    this.lastCalibration = {
      ...this.lastCalibration,
      advanceMs,
      deltaMs,
    };
    return this.calibrationResult;
  }

  abandonRun() {
    this.lifecycle.reset();
    this.measuredMicLeg = null;
  }

  clear() {
    this.abandonRun();
    this.completedContext = null;
    this.lastCalibration = null;
    this.pathDifference = null;
    this.resultConfidence = null;
    this.resetCorrelations();
  }

  private clearMicLeg() {
    this.measuredMicLeg = null;
    this.lifecycle.setMicMeasured(false);
  }
}
