import type { AudioSession } from './audio-session.js';
import type { BackingRuntime } from './backing-runtime.js';
import { combineBootCalibration } from './boot-calibration.js';
import { decideBootProbeAnalysisEvidence } from './boot-probe-analysis-evidence-policy.js';
import { decideBootProbeAnalysisReadiness } from './boot-probe-analysis-readiness-policy.js';
import { decideBootProbeReapplication } from './boot-probe-reapplication.js';
import { decideBootProbeRunIdentity } from './boot-probe-run-identity-policy.js';
import type { BootProbeRuntime } from './boot-probe-runtime.js';
import { bootProbeStartAuthorityAllowsAttempt, selectBootProbeStartTarget } from './boot-probe-start-policy.js';
import { bootProbeTopologyReady } from './boot-probe-topology-admission-policy.js';
import type { CalibrationApplicability } from './calibration-applicability.js';
import { locateProbe } from './calibration-probe.js';
import type { CalibrationSession } from './calibration-session.js';
import type { MicRuntime } from './mic-runtime.js';
import type { ProbeTarget } from './probe-lifecycle.js';
import { createRelayBootProbeCalibrationPromotionCoordinator } from './relay-boot-probe-calibration-promotion-coordinator.js';
import { createRelayBootProbeFailureSettlementCoordinator } from './relay-boot-probe-failure-settlement-coordinator.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import type { TimingCalibrationKind, TimingRuntime } from './timing-runtime.js';

type RangeEvidence = Pick<ReturnType<AudioSession['readMicEvidence']>, 'gapSamples' | 'frontierMissingSamples'>;
export type RelayBootProbeMessage = {
  type: 'play-calibration-probe'; target: ProbeTarget; requestId: number; leadMs: number;
};
export type RelayBootProbeDependencies<TSocket> = {
  readonly config: {
    readonly sampleRate: number;
    readonly leadMs: number;
    readonly searchMarginMs: number;
    readonly referenceMs: number;
    readonly analysisTimeoutMs: number;
    readonly minCorrelation: number;
    readonly maxCaptureGapMs: number;
    readonly reapplyThresholdMs: number;
    readonly debug: boolean;
  };
  readonly mix: Readonly<Pick<AudioSession,
    'active' | 'generation' | 'micGeneration' | 'backingGeneration' | 'micTotalSamples'
    | 'backingTotalSamples' | 'sessionSampleAt' | 'readMic' | 'readBacking'>> & {
    readonly alignment: Readonly<Pick<AudioSession['alignment'], 'calibratedMicLagMs'>>;
    readMicEvidence(startSample: number, count: number): RangeEvidence;
    readBackingEvidence(startSample: number, count: number): RangeEvidence;
  };
  readonly mic: Readonly<Pick<MicRuntime, 'controlConnected' | 'sampleRate'>> & {
    readonly publisher: TSocket | null;
  };
  readonly backing: Readonly<Pick<BackingRuntime<unknown>, 'isRobot' | 'connected' | 'sampleRate'>>;
  readonly source: Readonly<Pick<SourceRuntime<SourceRuntimeSocket>, 'connected'>> & {
    readonly socket: TSocket | null;
  };
  readonly probe: Readonly<Pick<BootProbeRuntime,
    'nextRequestId' | 'beginRequest' | 'micLegStaleForContext' | 'lifecycleIdle' | 'hasMicLeg'
    | 'completedContextMatches' | 'canStart' | 'acceptClientReply' | 'beginAnalysis'
    | 'pendingAnalysis' | 'takeAnalysis' | 'failAttempt' | 'noteCorrelation' | 'setMicLeg'
    | 'takeMicLegForContext' | 'recordCalibration' | 'pathDifferenceMs' | 'reapplyCalibration'
    | 'confidence' | 'abandonRun'>>;
  readonly calibration: Readonly<Pick<CalibrationSession,
    'collecting' | 'transactionActive' | 'failPreservingPrimed' | 'applyExternalResult'>> & {
    readonly result: Readonly<Pick<NonNullable<CalibrationSession['result']>, 'micLagMs' | 'confidence'>> | null;
  };
  readonly timing: Readonly<Pick<TimingRuntime,
    'calibrationKind' | 'beginBootProbe' | 'restoreCandidateKindToAuthority' | 'markBootProbeAuthority'>>;
  readonly queries: {
    robotRouteActive(): boolean;
    robotProbeTimingActive(): boolean;
    takeBlocksCalibration(): boolean;
    micPlayable(nowMs: number): boolean;
    backingPlayable(nowMs: number): boolean;
    calibrationIsStale(): boolean;
    probeStatus(nowMs: number): { error: string | null };
    appliedCalibrationKind(): TimingCalibrationKind;
    calibrationApplicability(kind?: TimingCalibrationKind): CalibrationApplicability;
    roomHasSong(nowMs: number): boolean;
    robotDeltaIsFresh(nowMs: number): boolean;
    currentDeltaMs(nowMs: number): number;
    currentPlaybackRate(nowMs: number): number;
    bootProbeAdvanceMs(nowMs: number): number | null;
  };
  readonly effects: {
    sendProbe(target: TSocket, message: RelayBootProbeMessage): void;
    reportTimingStatus(): void;
    debugLog(message: string): void;
  };
};

/** Synchronous workflow only. Canonical owners keep all identity, retry and result state. */
export function createRelayBootProbeOrchestration<TSocket>(dependencies: RelayBootProbeDependencies<TSocket>) {
  const session = dependencies.mix;
  const micRuntime = dependencies.mic;
  const backingRuntime = dependencies.backing;
  const sourceRuntime = dependencies.source;
  const bootProbeRuntime = dependencies.probe;
  const calibration = dependencies.calibration;
  const timingRuntime = dependencies.timing;
  const queries = dependencies.queries;
  const effects = dependencies.effects;
  // These are fixed configuration scalars, not snapshots of live owner facts.
  const { sampleRate: MIX_SAMPLE_RATE, leadMs: PROBE_LEAD_MS,
    searchMarginMs: PROBE_SEARCH_MARGIN_MS, referenceMs: PROBE_REFERENCE_MS,
    analysisTimeoutMs: PROBE_ANALYSIS_TIMEOUT_MS, minCorrelation: PROBE_MIN_CORRELATION,
    maxCaptureGapMs: MAX_CAPTURE_GAP_MS, reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS,
    debug: PROBE_DEBUG } = dependencies.config;

  function probeGeneration(target: ProbeTarget) {
    return target === 'mic' ? session.micGeneration : session.backingGeneration;
  }

  function bootProbeContext() {
    return {
      sessionGeneration: session.generation,
      micGeneration: session.micGeneration,
      backingGeneration: session.backingGeneration,
      micSourceRate: micRuntime.sampleRate,
      backingSourceRate: backingRuntime.sampleRate,
    };
  }

  function probePathReady(target: ProbeTarget, nowMs: number) {
    if (queries.robotRouteActive() && !bootProbeTopologyReady({
      backingIsRobot: backingRuntime.isRobot,
      robotSourceConnected: sourceRuntime.connected(),
    })) {
      return false;
    }
    if (target === 'mic') {
      return micRuntime.controlConnected() && queries.micPlayable(nowMs);
    }
    return backingRuntime.connected()
      && queries.backingPlayable(nowMs)
      && sourceRuntime.connected();
  }

  const bootProbeFailureSettlementCoordinator = createRelayBootProbeFailureSettlementCoordinator({
    restoreCandidateKindToAuthority: () => timingRuntime.restoreCandidateKindToAuthority(),
    failPreservingPrimed: message => calibration.failPreservingPrimed(message),
    reportTimingStatus: () => effects.reportTimingStatus(),
  });

  function failProbeAttempt(target: ProbeTarget, reason: string, nowMs: number) {
    const failure = bootProbeRuntime.failAttempt(target, reason, nowMs);
    bootProbeFailureSettlementCoordinator.settle(failure);
  }

  function sendProbeRequest(target: ProbeTarget, nowMs: number) {
    if (timingRuntime.calibrationKind !== 'boot-probe') {
      timingRuntime.beginBootProbe(true);
    }
    const requestId = bootProbeRuntime.nextRequestId();
    const request = {
      target, requestId, serverSentAtMs: nowMs,
      sessionGeneration: session.generation, generation: probeGeneration(target),
    };
    if (!bootProbeRuntime.beginRequest(request)) return;
    if (PROBE_DEBUG) effects.debugLog(`[probe] ${target} sent #${requestId} generation=${request.generation}`);
    const payload = { type: 'play-calibration-probe' as const, target, requestId, leadMs: PROBE_LEAD_MS };
    if (target === 'mic') {
      effects.sendProbe(micRuntime.publisher!, payload);
    } else if (sourceRuntime.socket) {
      effects.sendProbe(sourceRuntime.socket, payload);
    }
    effects.reportTimingStatus();
  }

  function abandonProbeRun() {
    bootProbeRuntime.abandonRun();
  }

  function maybeStartProbeCalibration(nowMs: number) {
    if (!queries.robotProbeTimingActive() || queries.takeBlocksCalibration()) return;
    if (!session.active || calibration.collecting) return;
    const context = bootProbeContext();
    if (bootProbeRuntime.micLegStaleForContext(context)) {
      abandonProbeRun();
    }
    const candidateIsBootProbe = timingRuntime.calibrationKind === 'boot-probe';
    const hasCalibrationResult = calibration.result !== null;
    if (!bootProbeStartAuthorityAllowsAttempt({
      candidateIsBootProbe, hasCalibrationResult,
      calibrationStale: candidateIsBootProbe && hasCalibrationResult ? queries.calibrationIsStale() : false,
      calibrationTransactionActive: calibration.transactionActive,
    })) return;
    if (!bootProbeRuntime.lifecycleIdle) return;
    const probeErrored = queries.probeStatus(nowMs).error !== null;
    const hasMicLeg = bootProbeRuntime.hasMicLeg;
    const completedContextMatches = !probeErrored
      && !calibration.transactionActive
      && !hasMicLeg
      && bootProbeRuntime.completedContextMatches(context);
    const target = selectBootProbeStartTarget({
      probeErrored, calibrationTransactionActive: calibration.transactionActive,
      hasMicLeg, completedContextMatches,
    });
    if (target === null) return;
    if (!bootProbeRuntime.canStart(target, nowMs)) return;
    if (!probePathReady(target, nowMs)) return;
    sendProbeRequest(target, nowMs);
  }

  function acceptCurrentProbeClientResult(
    reply: { requestId: unknown; generation: unknown },
    options: { logCaptureGenerationMismatch?: boolean } = {},
  ) {
    const pending = bootProbeRuntime.acceptClientReply(reply.requestId, reply.generation);
    if (!pending) return null;
    const sessionCurrent = session.active && pending.sessionGeneration === session.generation;
    const captureGenerationMatches = sessionCurrent ? probeGeneration(pending.target) === pending.generation : false;
    const identity = decideBootProbeRunIdentity({ sessionCurrent, captureGenerationMatches });
    if (identity.kind === 'abandon') {
      if (identity.reason === 'capture-generation' && options.logCaptureGenerationMismatch && PROBE_DEBUG) {
        effects.debugLog(`[probe] ${pending.target} dropped: capture generation changed`);
      }
      abandonProbeRun();
      effects.reportTimingStatus();
      return null;
    }
    return pending;
  }

  function handleProbeReply(reply: { requestId: unknown; generation: unknown }, nowMs: number) {
    const pending = acceptCurrentProbeClientResult(reply, { logCaptureGenerationMismatch: true });
    if (!pending) return;
    const oneWayMs = (nowMs - pending.serverSentAtMs) / 2;
    const targetSample = Math.round(session.sessionSampleAt(pending.serverSentAtMs + oneWayMs + PROBE_LEAD_MS));
    const marginSamples = Math.round((MIX_SAMPLE_RATE * PROBE_SEARCH_MARGIN_MS) / 1000);
    const referenceSamples = Math.round((MIX_SAMPLE_RATE * PROBE_REFERENCE_MS) / 1000);
    bootProbeRuntime.beginAnalysis({
      target: pending.target, targetSample,
      windowStart: targetSample - Math.round(marginSamples / 8),
      windowSamples: referenceSamples + marginSamples,
      sessionGeneration: pending.sessionGeneration, generation: pending.generation,
      deadlineMs: nowMs + PROBE_ANALYSIS_TIMEOUT_MS,
    });
    effects.reportTimingStatus();
  }

  function handleProbeFailure(reply: { requestId: unknown; generation: unknown; reason: unknown }, nowMs: number) {
    const pending = acceptCurrentProbeClientResult(reply);
    if (!pending) return;
    const rawReason = typeof reply.reason === 'string' ? reply.reason.trim() : '';
    const reason = rawReason ? rawReason.slice(0, 240) : 'client could not play the probe';
    failProbeAttempt(pending.target, reason, nowMs);
  }

  const bootProbeCalibrationPromotionCoordinator = createRelayBootProbeCalibrationPromotionCoordinator({
    markBootProbeAuthority: () => timingRuntime.markBootProbeAuthority(),
    applyExternalResult: result => calibration.applyExternalResult(result),
  });

  function promoteBootProbeCalibration(mutateProbe: () => void, result: () => { micLagMs: number; confidence: number }) {
    bootProbeCalibrationPromotionCoordinator.promote(mutateProbe, result);
  }

  function maybeFinishProbeAnalysis(nowMs: number) {
    const waiting = bootProbeRuntime.pendingAnalysis;
    if (!waiting) return;
    const reached = waiting.target === 'mic' ? session.micTotalSamples : session.backingTotalSamples;
    const needed = waiting.windowStart + waiting.windowSamples;
    const sessionCurrent = session.active && waiting.sessionGeneration === session.generation;
    const captureGenerationMatches = sessionCurrent ? probeGeneration(waiting.target) === waiting.generation : false;
    const readiness = decideBootProbeAnalysisReadiness({
      sessionCurrent, captureGenerationMatches, nowMs, deadlineMs: waiting.deadlineMs,
      reachedSamples: reached, neededSamples: needed,
    });
    if (readiness.kind === 'abandon') {
      if (readiness.reason === 'capture-generation' && PROBE_DEBUG) {
        effects.debugLog(`[probe] ${waiting.target} analysis dropped: capture generation changed`);
      }
      abandonProbeRun();
      effects.reportTimingStatus();
      return;
    }
    if (readiness.kind === 'timeout') {
      if (PROBE_DEBUG) {
        effects.debugLog(`[probe] ${waiting.target} analysis timed out: reached=${reached} needed=${needed}`);
      }
      bootProbeRuntime.takeAnalysis();
      failProbeAttempt(waiting.target, 'captured audio did not reach the analyzer before timeout', nowMs);
      return;
    }
    if (readiness.kind === 'wait') return;
    const analysis = bootProbeRuntime.takeAnalysis();
    if (!analysis) return;
    const rangeEvidence = analysis.target === 'mic'
      ? session.readMicEvidence(analysis.windowStart, analysis.windowSamples)
      : session.readBackingEvidence(analysis.windowStart, analysis.windowSamples);
    const evidenceDecision = decideBootProbeAnalysisEvidence({
      gapSamples: rangeEvidence.gapSamples, frontierMissingSamples: rangeEvidence.frontierMissingSamples,
      sampleRate: MIX_SAMPLE_RATE, maxGapMs: MAX_CAPTURE_GAP_MS,
    });
    if (evidenceDecision.kind === 'reject') {
      const reason = evidenceDecision.reason === 'frontier-missing'
        ? `captured audio window was incomplete (${evidenceDecision.frontierMissingSamples} samples beyond the capture frontier)`
        : `captured audio gap ${evidenceDecision.gapMs.toFixed(1)} ms exceeded ${MAX_CAPTURE_GAP_MS} ms`;
      failProbeAttempt(analysis.target, reason, nowMs);
      return;
    }
    const window = analysis.target === 'mic'
      ? session.readMic(analysis.windowStart, analysis.windowSamples)
      : session.readBacking(analysis.windowStart, analysis.windowSamples);
    const { offsetSamples, correlation } = locateProbe(window, MIX_SAMPLE_RATE);
    const actualSample = analysis.windowStart + offsetSamples;
    const latencyMs = ((actualSample - analysis.targetSample) / MIX_SAMPLE_RATE) * 1000;
    bootProbeRuntime.noteCorrelation(analysis.target, correlation);
    if (PROBE_DEBUG) {
      let peak = 0;
      for (let i = 0; i < window.length; i += 1) {
        const magnitude = Math.abs(window[i]);
        if (magnitude > peak) peak = magnitude;
      }
      const controlSeconds = 20;
      const recent = analysis.target === 'mic'
        ? session.readMic(reached - MIX_SAMPLE_RATE * controlSeconds, MIX_SAMPLE_RATE * controlSeconds)
        : session.readBacking(reached - MIX_SAMPLE_RATE * controlSeconds, MIX_SAMPLE_RATE * controlSeconds);
      let recentPeak = 0;
      for (let i = 0; i < recent.length; i += 1) {
        const magnitude = Math.abs(recent[i]);
        if (magnitude > recentPeak) recentPeak = magnitude;
      }
      effects.debugLog(`[probe] ${analysis.target} correlation=${correlation.toFixed(3)} latencyMs=${latencyMs.toFixed(0)}`
        + ` windowPeak=${peak} recent${controlSeconds}sPeak=${recentPeak}`
        + ` windowStart=${analysis.windowStart} needed=${needed} reached=${reached}`);
    }
    if (correlation < PROBE_MIN_CORRELATION) {
      failProbeAttempt(analysis.target,
        `correlation ${correlation.toFixed(3)} was below ${PROBE_MIN_CORRELATION.toFixed(3)}`, nowMs);
      return;
    }
    const leg = { targetSample: analysis.targetSample, actualSample, correlation };
    if (analysis.target === 'mic') {
      bootProbeRuntime.setMicLeg({ ...leg, sessionGeneration: session.generation,
        micGeneration: analysis.generation, micSourceRate: micRuntime.sampleRate });
      effects.reportTimingStatus();
      return;
    }
    const micLeg = bootProbeRuntime.takeMicLegForContext({ sessionGeneration: session.generation,
      micGeneration: session.micGeneration, micSourceRate: micRuntime.sampleRate });
    if (micLeg === null) return;
    const result = combineBootCalibration({ mic: micLeg, backing: leg,
      deltaMs: queries.currentDeltaMs(nowMs), sampleRate: MIX_SAMPLE_RATE,
      playbackRate: queries.currentPlaybackRate(nowMs) });
    if (PROBE_DEBUG) {
      effects.debugLog(`[probe] combined advanceMs=${result.advanceMs.toFixed(0)}`
        + ` (mic ${result.micLatencyMs.toFixed(0)} - backing ${result.backingLatencyMs.toFixed(0)}`
        + ` + delta ${result.deltaMs.toFixed(0)}) confidence=${result.confidence.toFixed(3)}`);
    }
    promoteBootProbeCalibration(
      () => bootProbeRuntime.recordCalibration(bootProbeContext(), result),
      () => ({ micLagMs: result.advanceMs, confidence: Math.max(0, Math.min(1, result.confidence)) }),
    );
  }

  function maybeReapplyBootCalibration(nowMs: number) {
    if (queries.takeBlocksCalibration()) return;
    if (!queries.robotRouteActive()) return;
    const appliedKind = queries.appliedCalibrationKind();
    const applied = session.alignment.calibratedMicLagMs;
    const decision = decideBootProbeReapplication({
      appliedKind,
      replacementApplicability: appliedKind === 'boot-probe' ? null : queries.calibrationApplicability(appliedKind),
      roomHasSong: queries.roomHasSong(nowMs),
      pathDifferenceReady: bootProbeRuntime.pathDifferenceMs !== null,
      calibrationCollecting: calibration.collecting,
      calibrationTransactionActive: calibration.transactionActive,
      robotDeltaFresh: queries.robotDeltaIsFresh(nowMs),
      completedContextMatches: bootProbeRuntime.completedContextMatches(bootProbeContext()),
      advanceMs: queries.bootProbeAdvanceMs(nowMs), appliedMicLagMs: applied,
      reapplyThresholdMs: BOOT_DELTA_REAPPLY_MS,
    });
    if (decision.kind === 'none') return;
    const advanceMs = decision.advanceMs;
    if (PROBE_DEBUG) {
      const why = decision.reason === 'reclaim' ? 'reclaimed by boot baseline' : 'delta moved';
      effects.debugLog(`[probe] ${why}; advanceMs ${applied?.toFixed(0) ?? 'none'} -> ${advanceMs.toFixed(0)}`);
    }
    promoteBootProbeCalibration(
      () => bootProbeRuntime.reapplyCalibration(advanceMs, queries.currentDeltaMs(nowMs)),
      () => ({ micLagMs: advanceMs, confidence: bootProbeRuntime.confidence ?? 0 }),
    );
  }

  return { context: bootProbeContext, stepAdmission: maybeStartProbeCalibration,
    stepAnalysis: maybeFinishProbeAnalysis, stepReapply: maybeReapplyBootCalibration,
    handleReply: handleProbeReply, handleFailure: handleProbeFailure,
    failAttempt: failProbeAttempt, abandon: abandonProbeRun };
}
