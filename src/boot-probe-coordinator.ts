import type { AudioSession } from './audio-session.js';
import { combineBootCalibration } from './boot-calibration.js';
import { BootProbeRuntime, type BootProbeContext } from './boot-probe-runtime.js';
import { decideBootProbeAnalysisEvidence } from './boot-probe-analysis-evidence-policy.js';
import { decideBootProbeAnalysisReadiness } from './boot-probe-analysis-readiness-policy.js';
import { decideBootProbeRunIdentity } from './boot-probe-run-identity-policy.js';
import { bootProbeStartAuthorityAllowsAttempt, selectBootProbeStartTarget } from './boot-probe-start-policy.js';
import { bootProbeTopologyReady } from './boot-probe-topology-admission-policy.js';
import { MAX_CAPTURE_GAP_MS, type CalibrationSession } from './calibration-session.js';
import { locateProbe, PROBE_REFERENCE_MS } from './calibration-probe.js';
import type { ProbeTarget } from './probe-lifecycle.js';
import { probeScheduleTime, sanitizeProbeTimingDiagnostics } from './probe-timing-diagnostics.js';
import type { TimingRuntime } from './timing-runtime.js';

export type BootProbeCoordinatorConfig = {
  sampleRate: number;
  maxAttempts: number;
  retryMs: number;
  leadMs: number;
  searchMarginMs: number;
  minCorrelation: number;
  replyTimeoutMs: number;
  analysisTimeoutMs: number;
  debug: boolean;
};

type ProbeTimingEvidence = {
  requestId: number;
  sessionGeneration: number;
  captureGeneration: number | null;
  serverReceivedAtMs: number;
  roundTripMs: number;
  client: ReturnType<typeof sanitizeProbeTimingDiagnostics>;
  schedule: ReturnType<typeof probeScheduleTime>;
  targetSample?: number;
  actualSample?: number;
  latencyMs?: number;
  correlation?: number;
  serverAnalyzedAtMs?: number;
};
type ProbeTimingSnapshot = Readonly<Partial<Record<ProbeTarget, Readonly<ProbeTimingEvidence>>>>;

type ProbeAudio = Pick<AudioSession,
  'active' | 'generation' | 'micGeneration' | 'backingGeneration'
  | 'micTotalSamples' | 'backingTotalSamples' | 'sessionSampleAt'
  | 'readMic' | 'readBacking' | 'readMicEvidence' | 'readBackingEvidence'
  | 'noteMicCalibrationMeasured'
>;

export type BootProbeHost = {
  audio: ProbeAudio;
  calibration: Pick<CalibrationSession,
    'result' | 'collecting' | 'transactionActive' | 'applyExternalResult' | 'failPreservingPrimed'
  >;
  timing: Pick<TimingRuntime,
    'calibrationKind' | 'beginBootProbe' | 'markBootProbeAuthority' | 'restoreCandidateKindToAuthority'
  >;
  context: () => BootProbeContext;
  sourceRate: (target: ProbeTarget) => number | null;
  enabled: () => boolean;
  takeBlocked: () => boolean;
  calibrationStale: () => boolean;
  robotRouteActive: () => boolean;
  topology: () => { backingIsRobot: boolean; robotSourceConnected: boolean };
  pathReady: (target: ProbeTarget, nowMs: number) => boolean;
  deltaMs: (nowMs: number) => number;
  playbackRate: (nowMs: number) => number;
  send: (target: ProbeTarget, request: { type: string; target: ProbeTarget; requestId: number; leadMs: number }) => void;
  changed: () => void;
  onBackingMeasured: (latencyMs: number) => void;
};

/**
 * Executes one two-leg boot measurement. Request identity, retry cadence,
 * captured evidence, diagnostics and promotion stay in the same transaction.
 * AudioSession owns PCM; transport adapters only deliver requests and replies.
 * CalibrationSession and TimingRuntime retain measurement/provenance authority.
 */
export class BootProbeCoordinator {
  private readonly runtime: BootProbeRuntime;
  private readonly audio: ProbeAudio;
  private readonly calibration: BootProbeHost['calibration'];
  private readonly timing: BootProbeHost['timing'];
  private readonly evidence: Partial<Record<ProbeTarget, ProbeTimingEvidence>> = {};
  private completedEvidence: Partial<Record<ProbeTarget, ProbeTimingEvidence>> | null = null;

  constructor(
    private readonly config: BootProbeCoordinatorConfig,
    private readonly host: BootProbeHost,
    private readonly analyzeProbe = locateProbe,
  ) {
    this.runtime = new BootProbeRuntime(config);
    this.audio = host.audio;
    this.calibration = host.calibration;
    this.timing = host.timing;
  }

  get idle() { return this.runtime.lifecycleIdle; }
  get hasMicLeg() { return this.runtime.hasMicLeg; }
  get pathDifferenceMs() { return this.runtime.pathDifferenceMs; }
  get calibrationResult() { return this.runtime.calibrationResult; }
  get correlations() { return this.runtime.correlations; }
  get timingEvidence(): ProbeTimingSnapshot { return this.evidence; }
  get completedTimingEvidence(): ProbeTimingSnapshot | null { return this.completedEvidence; }

  status(nowMs: number) { return this.runtime.status(nowMs); }

  completedContextMatches(context: BootProbeContext) {
    return this.runtime.completedContextMatches(context);
  }

  abandon() { this.runtime.abandonRun(); }

  clear() {
    this.runtime.clear();
    this.completedEvidence = null;
  }

  restart(nowMs: number) {
    this.timing.beginBootProbe(false);
    this.abandon();
    this.runtime.resetCorrelations();
    this.startIfReady(nowMs);
    this.host.changed();
  }

  expireRequest(nowMs: number) {
    const expired = this.runtime.takeExpiredRequest(nowMs, this.config.replyTimeoutMs);
    if (expired) this.failAttempt(expired.target, 'playback acknowledgement timed out', nowMs);
  }

  reapply(advanceMs: number, deltaMs: number) {
    this.promote(
      () => this.runtime.reapplyCalibration(advanceMs, deltaMs),
      () => ({ micLagMs: advanceMs, confidence: this.runtime.confidence ?? 0 }),
    );
  }

  private captureGeneration(target: ProbeTarget) {
    return target === 'mic' ? this.audio.micGeneration : this.audio.backingGeneration;
  }

  private timeline(target: ProbeTarget) {
    return target === 'mic'
      ? {
        totalSamples: this.audio.micTotalSamples,
        read: (start: number, count: number) => this.audio.readMic(start, count),
        evidence: (start: number, count: number) => this.audio.readMicEvidence(start, count),
      }
      : {
        totalSamples: this.audio.backingTotalSamples,
        read: (start: number, count: number) => this.audio.readBacking(start, count),
        evidence: (start: number, count: number) => this.audio.readBackingEvidence(start, count),
      };
  }

  private peakMagnitude(samples: Int16Array) {
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    return peak;
  }

  private pathReady(target: ProbeTarget, nowMs: number) {
    if (this.host.robotRouteActive() && !bootProbeTopologyReady(this.host.topology())) return false;
    return this.host.pathReady(target, nowMs);
  }

  private failAttempt(target: ProbeTarget, reason: string, nowMs: number) {
    const failure = this.runtime.failAttempt(target, reason, nowMs);
    const probe = this.runtime.status(nowMs);
    console.log('[probe-attempt-failed]', JSON.stringify({
      target, reason, attempt: probe.attempts[target], maxAttempts: probe.maxAttempts,
      terminal: failure !== null,
    }));
    if (failure) {
      this.timing.restoreCandidateKindToAuthority();
      this.calibration.failPreservingPrimed(failure.message);
      return;
    }
    this.host.changed();
  }

  private request(target: ProbeTarget, nowMs: number) {
    if (this.timing.calibrationKind !== 'boot-probe') {
      this.timing.beginBootProbe(true);
    }

    const requestId = this.runtime.nextRequestId();
    const request = {
      target,
      requestId,
      serverSentAtMs: nowMs,
      sessionGeneration: this.audio.generation,
      generation: this.captureGeneration(target),
    };
    if (!this.runtime.beginRequest(request)) return;
    delete this.evidence[target];

    if (this.config.debug) console.log(`[probe] ${target} sent #${requestId} generation=${request.generation}`);

    const payload = { type: 'play-calibration-probe', target, requestId, leadMs: this.config.leadMs };
    this.host.send(target, payload);
    this.host.changed();
  }

  startIfReady(nowMs: number) {
    if (!this.host.enabled() || this.host.takeBlocked()) return;
    if (!this.audio.active || this.calibration.collecting) return;

    const context = this.host.context();
    if (this.runtime.micLegStaleForContext(context)) {
      this.abandon();
    }

    const candidateIsBootProbe = this.timing.calibrationKind === 'boot-probe';
    const hasCalibrationResult = this.calibration.result !== null;
    if (!bootProbeStartAuthorityAllowsAttempt({
      candidateIsBootProbe,
      hasCalibrationResult,
      calibrationStale: candidateIsBootProbe && hasCalibrationResult
        ? this.host.calibrationStale()
        : false,
      calibrationTransactionActive: this.calibration.transactionActive,
    })) return;

    if (!this.runtime.lifecycleIdle) return;

    const probeErrored = this.status(nowMs).error !== null;
    const hasMicLeg = this.runtime.hasMicLeg;
    const completedContextMatches = !probeErrored
      && !this.calibration.transactionActive
      && !hasMicLeg
      && this.runtime.completedContextMatches(context);
    const target = selectBootProbeStartTarget({
      probeErrored,
      calibrationTransactionActive: this.calibration.transactionActive,
      hasMicLeg,
      completedContextMatches,
    });
    if (target === null) return;
    if (!this.runtime.canStart(target, nowMs)) return;
    if (!this.pathReady(target, nowMs)) return;
    this.request(target, nowMs);
  }

  private acceptClientResult(
    reply: { requestId: unknown; generation: unknown },
    options: { logCaptureGenerationMismatch?: boolean } = {},
  ) {
    const pending = this.runtime.acceptClientReply(reply.requestId, reply.generation);
    if (!pending) return null;

    const sessionCurrent = this.audio.active
      && pending.sessionGeneration === this.audio.generation;
    const captureGenerationMatches = sessionCurrent
      ? this.captureGeneration(pending.target) === pending.generation
      : false;
    const identity = decideBootProbeRunIdentity({
      sessionCurrent,
      captureGenerationMatches,
    });

    if (identity.kind === 'abandon') {
      if (
        identity.reason === 'capture-generation'
        && options.logCaptureGenerationMismatch
        && this.config.debug
      ) {
        console.log(`[probe] ${pending.target} dropped: capture generation changed`);
      }
      this.abandon();
      this.host.changed();
      return null;
    }

    return pending;
  }

  played(reply: { requestId: unknown; generation: unknown; timingDiagnostics?: unknown }, nowMs: number) {
    const pending = this.acceptClientResult(reply, { logCaptureGenerationMismatch: true });
    if (!pending) return;

    const client = sanitizeProbeTimingDiagnostics(reply.timingDiagnostics);
    const schedule = probeScheduleTime(pending.serverSentAtMs, nowMs, this.config.leadMs, client);
    this.evidence[pending.target] = {
      requestId: pending.requestId, sessionGeneration: pending.sessionGeneration,
      captureGeneration: pending.generation, serverReceivedAtMs: nowMs,
      roundTripMs: nowMs - pending.serverSentAtMs,
      client, schedule,
    };
    const targetSample = Math.round(this.audio.sessionSampleAt(schedule.targetAtMs));
    const marginSamples = Math.round((this.config.sampleRate * this.config.searchMarginMs) / 1000);
    const referenceSamples = Math.round((this.config.sampleRate * PROBE_REFERENCE_MS) / 1000);

    this.runtime.beginAnalysis({
      target: pending.target,
      targetSample,
      windowStart: targetSample - Math.round(marginSamples / 8),
      windowSamples: referenceSamples + marginSamples,
      sessionGeneration: pending.sessionGeneration,
      generation: pending.generation,
      deadlineMs: nowMs + this.config.analysisTimeoutMs,
    });
    this.host.changed();
  }

  failed(
    reply: { requestId: unknown; generation: unknown; reason: unknown },
    nowMs: number,
  ) {
    const pending = this.acceptClientResult(reply);
    if (!pending) return;

    const rawReason = typeof reply.reason === 'string' ? reply.reason.trim() : '';
    const reason = rawReason ? rawReason.slice(0, 240) : 'client could not play the probe';
    this.failAttempt(pending.target, reason, nowMs);
  }

  private promote(
    mutateProbe: () => void,
    result: () => { micLagMs: number; confidence: number },
  ) {
    mutateProbe();
    this.timing.markBootProbeAuthority();
    this.calibration.applyExternalResult(result());
  }

  finishAnalysis(nowMs: number) {
    const waiting = this.runtime.pendingAnalysis;
    if (!waiting) return;

    const reached = this.timeline(waiting.target).totalSamples;
    const needed = waiting.windowStart + waiting.windowSamples;
    const sessionCurrent = this.audio.active
      && waiting.sessionGeneration === this.audio.generation;
    const captureGenerationMatches = sessionCurrent
      ? this.captureGeneration(waiting.target) === waiting.generation
      : false;
    const readiness = decideBootProbeAnalysisReadiness({
      sessionCurrent,
      captureGenerationMatches,
      nowMs,
      deadlineMs: waiting.deadlineMs,
      reachedSamples: reached,
      neededSamples: needed,
    });

    if (readiness.kind === 'abandon') {
      if (readiness.reason === 'capture-generation' && this.config.debug) {
        console.log(`[probe] ${waiting.target} analysis dropped: capture generation changed`);
      }
      this.abandon();
      this.host.changed();
      return;
    }

    if (readiness.kind === 'timeout') {
      if (this.config.debug) {
        console.log(
          `[probe] ${waiting.target} analysis timed out: reached=${reached} needed=${needed}`,
        );
      }
      this.runtime.takeAnalysis();
      this.failAttempt(waiting.target, 'captured audio did not reach the analyzer before timeout', nowMs);
      return;
    }

    if (readiness.kind === 'wait') return;
    const analysis = this.runtime.takeAnalysis();
    if (!analysis) return;

    const timeline = this.timeline(analysis.target);
    const rangeEvidence = timeline.evidence(analysis.windowStart, analysis.windowSamples);
    const evidenceDecision = decideBootProbeAnalysisEvidence({
      gapSamples: rangeEvidence.gapSamples,
      frontierMissingSamples: rangeEvidence.frontierMissingSamples,
      sampleRate: this.config.sampleRate,
      maxGapMs: MAX_CAPTURE_GAP_MS,
    });
    if (evidenceDecision.kind === 'reject') {
      const reason = evidenceDecision.reason === 'frontier-missing'
        ? `captured audio window was incomplete (${evidenceDecision.frontierMissingSamples} samples beyond the capture frontier)`
        : `captured audio gap ${evidenceDecision.gapMs.toFixed(1)} ms exceeded ${MAX_CAPTURE_GAP_MS} ms`;
      this.failAttempt(analysis.target, reason, nowMs);
      return;
    }

    const window = timeline.read(analysis.windowStart, analysis.windowSamples);
    const { offsetSamples, correlation } = this.analyzeProbe(window, this.config.sampleRate);
    const actualSample = analysis.windowStart + offsetSamples;
    const latencyMs = ((actualSample - analysis.targetSample) / this.config.sampleRate) * 1000;
    this.runtime.noteCorrelation(analysis.target, correlation);

    if (this.config.debug) {
      const controlSeconds = 20;
      const recent = timeline.read(reached - this.config.sampleRate * controlSeconds, this.config.sampleRate * controlSeconds);
      console.log(
        `[probe] ${analysis.target} correlation=${correlation.toFixed(3)} latencyMs=${latencyMs.toFixed(0)}`
        + ` windowPeak=${this.peakMagnitude(window)} recent${controlSeconds}sPeak=${this.peakMagnitude(recent)}`
        + ` windowStart=${analysis.windowStart} needed=${needed} reached=${reached}`,
      );
    }

    if (correlation < this.config.minCorrelation) {
      // The attempt ran and the chime was not in the capture: with headphones it
      // never reaches the Mic, so trying again the same way will not find it.
      this.runtime.markAttemptUnheard(analysis.target);
      this.failAttempt(
        analysis.target,
        `correlation ${correlation.toFixed(3)} was below ${this.config.minCorrelation.toFixed(3)}`,
        nowMs,
      );
      return;
    }

    const leg = { targetSample: analysis.targetSample, actualSample, correlation };
    const evidence = this.evidence[analysis.target];
    if (evidence && evidence.sessionGeneration === analysis.sessionGeneration
      && evidence.captureGeneration === analysis.generation) {
      Object.assign(evidence, { targetSample: analysis.targetSample, actualSample,
        latencyMs, correlation, serverAnalyzedAtMs: nowMs });
    }

    if (analysis.target === 'mic') {
      this.runtime.setMicLeg({
        ...leg,
        sessionGeneration: this.audio.generation,
        micGeneration: analysis.generation,
        micSourceRate: this.host.sourceRate('mic'),
      });
      this.host.changed();
      return;
    }

    // The Robot leg stands on its own: keep it for the second Mic, whoever
    // holds the Mic next.
    this.host.onBackingMeasured(latencyMs);

    const micLeg = this.runtime.takeMicLegForContext({
      sessionGeneration: this.audio.generation,
      micGeneration: this.audio.micGeneration,
      micSourceRate: this.host.sourceRate('mic'),
    });
    if (micLeg === null) return;

    const result = combineBootCalibration({
      mic: micLeg,
      backing: leg,
      deltaMs: this.host.deltaMs(nowMs),
      sampleRate: this.config.sampleRate,
      playbackRate: this.host.playbackRate(nowMs),
    });

    if (this.config.debug) {
      console.log(
        `[probe] combined advanceMs=${result.advanceMs.toFixed(0)}`
        + ` (mic ${result.micLatencyMs.toFixed(0)} - backing ${result.backingLatencyMs.toFixed(0)}`
        + ` + delta ${result.deltaMs.toFixed(0)}) confidence=${result.confidence.toFixed(3)}`,
      );
    }

    this.promote(
      () => {
        this.runtime.recordCalibration(this.host.context(), result);
        this.completedEvidence = structuredClone(this.evidence);
        this.audio.noteMicCalibrationMeasured();
      },
      () => ({
        micLagMs: result.advanceMs,
        confidence: Math.max(0, Math.min(1, result.confidence)),
      }),
    );
  }
}
