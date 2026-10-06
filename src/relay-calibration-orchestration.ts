import type { AudioSession } from './audio-session.js';
import { autoContentCalibrationAuthorityAllowsStart, autoContentCalibrationLivePathReady, autoContentCalibrationPrerequisitesReady, autoContentCalibrationStartMode } from './auto-content-calibration-policy.js';
import type { ContentCalibrationValidator } from './content-calibration-validator.js';
import { decideContentValidationBaselineSync } from './content-validation-baseline-policy.js';
import { contentValidationAuthorityReady, contentValidationLivePathReady, contentValidationPathPrerequisitesReady } from './content-validation-path-policy.js';
import type { BackingRuntime } from './backing-runtime.js';
import { mediaToWallMs } from './boot-calibration.js';
import type { BootProbeContext, BootProbeRuntime } from './boot-probe-runtime.js';
import { decideBootProbeMixerApplication } from './boot-probe-mixer-application.js';
import { decideCalibrationApplicability, type CalibrationApplicability } from './calibration-applicability.js';
import { decideCalibrationMixerApplication } from './calibration-mixer-application.js';
import type { CalibrationContext, CalibrationSession } from './calibration-session.js';
import type { MicRuntime } from './mic-runtime.js';
import type { RobotContentTimelineMapper } from './robot-content-timeline.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import type { TimingRuntime } from './timing-runtime.js';
import type { RobotPlayerOffsetTracker } from './robot-player-offset.js';
import { createRelayLiveSourceStopCoordinator } from './relay-live-source-stop-coordinator.js';
import { createRelayMicTimingInvalidationCoordinator } from './relay-mic-timing-invalidation-coordinator.js';
import { createRelayManualBootRecalibrationCoordinator } from './relay-manual-boot-recalibration-coordinator.js';

type LagResult = Readonly<Pick<NonNullable<CalibrationSession['result']>, 'micLagMs'>>;
export type RelayCalibrationDependencies = {
  readonly config: { readonly reapplyThresholdMs: number };
  readonly clock: Readonly<{ now(): number }>;
  readonly mix: Readonly<Pick<AudioSession,
    'generation' | 'micGeneration' | 'backingGeneration' | 'calibratedMicLagTarget' | 'slewCalibratedMicLagTo'>> & {
    readonly alignment: Readonly<Pick<AudioSession['alignment'], 'calibratedMicLagMs'>>;
    setAlignment(input: Pick<AudioSession['alignment'], 'calibratedMicLagMs'>): void;
  };
  readonly mic: Readonly<Pick<MicRuntime, 'sampleRate'>>;
  readonly backing: Readonly<Pick<BackingRuntime<unknown>, 'sampleRate'>>;
  readonly source: Readonly<Pick<SourceRuntime<SourceRuntimeSocket>, 'generation' | 'connected'>>;
  readonly calibration: Readonly<Pick<CalibrationSession, 'isStaleFor' | 'transactionActive' | 'confirmedRevision'>> & {
    readonly result: LagResult | null;
    readonly confirmedResult: LagResult | null;
    status(): Readonly<Pick<ReturnType<CalibrationSession['status']>, 'provisional'>>;
  };
  readonly timing: Readonly<Pick<TimingRuntime,
    'appliedCalibrationKind' | 'contentValidationSlewRevision' | 'contentValidationSlewMatches' | 'clearContentValidationSlew'>>;
  readonly probe: Readonly<Pick<BootProbeRuntime, 'pathDifferenceMs' | 'completedContextMatches'>> & {
    readonly calibrationResult: Readonly<Pick<NonNullable<BootProbeRuntime['calibrationResult']>, 'deltaMs'>> | null;
  };
  readonly contentTimeline: Readonly<Pick<RobotContentTimelineMapper, 'liveLagMs'>>;
  readonly queries: Readonly<{
    takeBlocksCalibration(): boolean;
    robotRouteActive(): boolean;
    robotProbeTimingActive(): boolean;
    bootProbeSettled(nowMs: number): boolean;
    bootProbeContext(): BootProbeContext;
    roomHasSong(nowMs: number): boolean;
    robotDeltaIsFresh(nowMs: number): boolean;
    robotDeltaEverEstablished(): boolean;
    robotContentMappingReady(nowMs: number): boolean;
    currentDeltaMs(nowMs: number): number;
    currentPlaybackRate(nowMs: number): number;
  }>;
};

/** Application sampling and mixer commands only; canonical owners retain every authority. */
export function createRelayCalibrationOrchestration(dependencies: RelayCalibrationDependencies) {
  const session = dependencies.mix;
  const micRuntime = dependencies.mic;
  const backingRuntime = dependencies.backing;
  const sourceRuntime = dependencies.source;
  const calibration = dependencies.calibration;
  const timingRuntime = dependencies.timing;
  const bootProbeRuntime = dependencies.probe;
  const robotContentTimeline = dependencies.contentTimeline;
  const queries = dependencies.queries;
  const performance = dependencies.clock;
  // Fixed configuration, not a snapshot of result, provenance or alignment.
  const BOOT_DELTA_REAPPLY_MS = dependencies.config.reapplyThresholdMs;

  function calibrationContext(): CalibrationContext {
    return {
      sessionGeneration: session.generation,
      micGeneration: session.micGeneration,
      backingGeneration: session.backingGeneration,
      micSourceRate: micRuntime.sampleRate,
      backingSourceRate: backingRuntime.sampleRate,
      sourceGeneration: sourceRuntime.generation,
    };
  }

  function calibrationIsStale() {
    return calibration.isStaleFor(calibrationContext());
  }

  function appliedCalibrationKind() {
    const status = calibration.status();
    return timingRuntime.appliedCalibrationKind({
      hasConfirmedResult: calibration.confirmedResult !== null,
      provisional: status.provisional,
    });
  }

  function calibrationApplicability(kind = appliedCalibrationKind()): CalibrationApplicability {
    const nowMs = performance.now();
    const result = calibration.result;
    const status = calibration.status();
    return decideCalibrationApplicability({
      kind,
      hasResult: result !== null,
      stale: result !== null && calibrationIsStale(),
      calibrationTransactionActive: calibration.transactionActive,
      calibrationProvisional: status.provisional,
      hasConfirmedResult: calibration.confirmedResult !== null,
      robotProbeTimingActive: queries.robotProbeTimingActive(),
      bootProbeSettled: queries.bootProbeSettled(nowMs),
      robotRouteActive: queries.robotRouteActive(),
      robotSourceConnected: sourceRuntime.connected(),
      roomHasSong: queries.roomHasSong(nowMs),
      robotDeltaFresh: queries.robotDeltaIsFresh(nowMs),
      robotDeltaEverEstablished: queries.robotDeltaEverEstablished(),
      robotContentMappingReady: queries.robotContentMappingReady(nowMs),
    });
  }

  function bootProbeAdvanceMs(nowMs: number) {
    const pathDifferenceMs = bootProbeRuntime.pathDifferenceMs;
    if (pathDifferenceMs === null) return null;

    return pathDifferenceMs + mediaToWallMs(queries.currentDeltaMs(nowMs), queries.currentPlaybackRate(nowMs));
  }

  function contentLiveLagMs(referenceLagMs: number, nowMs: number) {
    return robotContentTimeline.liveLagMs(referenceLagMs, calibrationContext(), nowMs);
  }

  function desiredCalibratedMicLagMs(nowMs: number): number | null {
    const kind = appliedCalibrationKind();

    if (queries.robotRouteActive() && kind === 'boot-probe') {
      if (calibration.result === null || calibrationIsStale()) return null;
      if (!bootProbeRuntime.completedContextMatches(queries.bootProbeContext())) return null;

      if (!queries.roomHasSong(nowMs)) return bootProbeRuntime.pathDifferenceMs;
      if (calibrationApplicability(kind) !== 'apply') return null;
      return bootProbeAdvanceMs(nowMs);
    }

    if (calibrationApplicability(kind) !== 'apply') return null;
    const result = calibration.result;
    if (result === null) return null;
    if (!queries.robotRouteActive() || kind !== 'content') return result.micLagMs;
    return contentLiveLagMs(result.micLagMs, nowMs);
  }

  function syncAppliedCalibration() {
    if (queries.takeBlocksCalibration()) return false;
    const active = session.alignment.calibratedMicLagMs;
    const calibrationKind = appliedCalibrationKind();

    if (queries.robotRouteActive() && calibrationKind === 'boot-probe') {
      const nowMs = performance.now();
      const result = calibration.result;
      const decision = decideBootProbeMixerApplication({
        activeMicLagMs: active,
        roomHasSong: queries.roomHasSong(nowMs),
        resultMicLagMs: result?.micLagMs ?? null,
        pathDifferenceMs: bootProbeRuntime.pathDifferenceMs,
        calibrationStale: calibrationIsStale(),
        completedContextMatches: bootProbeRuntime.completedContextMatches(queries.bootProbeContext()),
        applicability: calibrationApplicability(calibrationKind),
        storedDeltaMs: bootProbeRuntime.calibrationResult?.deltaMs ?? null,
        currentDeltaMs: queries.currentDeltaMs(nowMs),
      });
      if (decision.kind === 'hold') return false;
      session.setAlignment({ calibratedMicLagMs: decision.micLagMs });
      return true;
    }
    const applicability = calibrationApplicability(calibrationKind);
    let nextMicLagMs = applicability === 'apply' ? calibration.result!.micLagMs : null;
    const robotContentAuthority = queries.robotRouteActive() && calibrationKind === 'content';
    if (nextMicLagMs !== null && robotContentAuthority) {
      nextMicLagMs = contentLiveLagMs(nextMicLagMs, performance.now());
    }

    const decision = decideCalibrationMixerApplication({
      applicability,
      calibrationKind,
      activeMicLagMs: active,
      nextMicLagMs,
      robotContentAuthority,
      hasContentValidationSlew: timingRuntime.contentValidationSlewRevision !== null,
      contentValidationSlewMatchesRevision:
        timingRuntime.contentValidationSlewMatches(calibration.confirmedRevision),
      calibratedMicLagTarget: session.calibratedMicLagTarget,
      jitterThresholdMs: BOOT_DELTA_REAPPLY_MS,
    });
    if (decision.clearContentValidationSlew) timingRuntime.clearContentValidationSlew();
    if (decision.kind === 'none') return false;
    if (decision.kind === 'slew') return session.slewCalibratedMicLagTo(decision.micLagMs);
    session.setAlignment({ calibratedMicLagMs: decision.micLagMs });
    return true;
  }

  return {
    context: calibrationContext,
    isStale: calibrationIsStale,
    appliedKind: appliedCalibrationKind,
    applicability: calibrationApplicability,
    bootAdvance: bootProbeAdvanceMs,
    contentLiveLag: contentLiveLagMs,
    desiredLag: desiredCalibratedMicLagMs,
    syncApplied: syncAppliedCalibration,
  } as const;
}

export type RelayContentCalibrationDependencies = {
  readonly config: { readonly autoEnabled: boolean; readonly validationEnabled: boolean };
  readonly clock: Readonly<{ now(): number }>;
  readonly mix: Readonly<Pick<AudioSession, 'active'>>;
  readonly calibration: Readonly<Pick<CalibrationSession,
    'confirmedRevision' | 'collecting' | 'start' | 'startFromPrimed'>> & {
    readonly confirmedResult: Readonly<Pick<NonNullable<CalibrationSession['confirmedResult']>,
      'micLagMs' | 'confidence' | 'segmentLagsMs'>> | null;
  };
  readonly timing: Readonly<Pick<TimingRuntime,
    'clearContentValidationBaseline' | 'contentValidationBaselineRevision'
    | 'markContentValidationBaseline' | 'autoCalibrationDue' | 'beginContentCalibration'>>;
  readonly validator: Readonly<Pick<ContentCalibrationValidator,
    'hasBaseline' | 'collecting' | 'setBaseline' | 'clearBaseline' | 'cancel' | 'tick' | 'maybeStart'>> & {
    status(nowMs: number): Readonly<Pick<ReturnType<ContentCalibrationValidator['status']>, 'state'>>;
  };
  readonly backing: Readonly<Pick<BackingRuntime<unknown>, 'connected'>>;
  readonly mic: Readonly<Pick<MicRuntime, 'controlConnected'>>;
  readonly queries: Readonly<{
    calibrationContext(): CalibrationContext;
    appliedCalibrationKind(): ReturnType<TimingRuntime['appliedCalibrationKind']>;
    calibrationIsStale(): boolean;
    takeBlocksCalibration(): boolean;
    robotRouteActive(): boolean;
    bootProbeSettled(nowMs: number): boolean;
    robotContentEvidenceMappingReady(nowMs: number): boolean;
    bothStreamsFlowing(nowMs: number): boolean;
    currentTimelineStatus(nowMs?: number): Readonly<{ connected?: boolean; state?: number }>;
    probeCalibrationExhausted(nowMs: number): boolean;
  }>;
  readonly effects: Readonly<{ reportTimingStatus(): void }>;
};

/** Content workflow ordering only; validator/calibration/TimingRuntime retain all state. */
export function createRelayContentCalibrationOrchestration(dependencies: RelayContentCalibrationDependencies) {
  const session = dependencies.mix;
  const calibration = dependencies.calibration;
  const timingRuntime = dependencies.timing;
  const contentCalibrationValidator = dependencies.validator;
  const backingRuntime = dependencies.backing;
  const micRuntime = dependencies.mic;
  const performance = dependencies.clock;
  const queries = dependencies.queries;
  const effects = dependencies.effects;
  const AUTO_CALIBRATE = dependencies.config.autoEnabled;
  const CONTENT_VALIDATION_ENABLED = dependencies.config.validationEnabled;

  function clearContentValidationBaseline() {
    timingRuntime.clearContentValidationBaseline();
    contentCalibrationValidator.clearBaseline();
  }

  function syncContentValidationBaseline(nowMs: number) {
    const confirmed = calibration.confirmedResult;
    const decision = decideContentValidationBaselineSync({
      appliedKind: queries.appliedCalibrationKind(),
      hasConfirmedResult: confirmed !== null,
      calibrationStale: confirmed !== null && queries.calibrationIsStale(),
      hasBaseline: contentCalibrationValidator.hasBaseline,
      baselineRevision: timingRuntime.contentValidationBaselineRevision,
      confirmedRevision: calibration.confirmedRevision,
    });

    if (decision === 'none') return;
    if (decision === 'clear') {
      clearContentValidationBaseline();
      return;
    }
    if (confirmed === null) return;

    contentCalibrationValidator.setBaseline({
      micLagMs: confirmed.micLagMs,
      confidence: confirmed.confidence,
      segmentLagsMs: confirmed.segmentLagsMs,
      context: queries.calibrationContext(),
    }, nowMs);
    timingRuntime.markContentValidationBaseline(calibration.confirmedRevision);
  }

  function cancelActiveContentValidation(nowMs = performance.now()) {
    const state = contentCalibrationValidator.status(nowMs).state;
    if (!contentCalibrationValidator.collecting && state !== 'suspect') return false;
    contentCalibrationValidator.cancel(nowMs);
    return true;
  }

  function maybeAutoCalibrate(nowMs: number) {



    if (!AUTO_CALIBRATE || queries.takeBlocksCalibration()) return;
    const robotRoute = queries.robotRouteActive();
    if (!autoContentCalibrationPrerequisitesReady({
      bootProbeSettled: queries.bootProbeSettled(nowMs),
      robotRouteActive: robotRoute,
      robotEvidenceMappingReady: !robotRoute || queries.robotContentEvidenceMappingReady(nowMs),
      sessionActive: session.active,
      calibrationCollecting: calibration.collecting,
    })) return;

    const freshConfirmedResult = calibration.confirmedResult !== null && !queries.calibrationIsStale();



    const appliedKind = freshConfirmedResult && robotRoute
      ? queries.appliedCalibrationKind()
      : null;
    if (!autoContentCalibrationAuthorityAllowsStart({
      freshConfirmedResult,
      robotRouteActive: robotRoute,
      appliedKind,
    })) return;



    const retryDue = timingRuntime.autoCalibrationDue(nowMs);
    const backingConnected = retryDue && backingRuntime.connected();
    const micControlConnected = backingConnected && micRuntime.controlConnected();
    const streamsFlowing = micControlConnected && queries.bothStreamsFlowing(nowMs);
    const timeline = streamsFlowing ? queries.currentTimelineStatus() : null;
    if (!autoContentCalibrationLivePathReady({
      retryDue,
      backingConnected,
      micControlConnected,
      streamsFlowing,
      timelineConnected: Boolean(timeline?.connected),
      timelinePlaying: Number(timeline?.state) === 1,
    })) return;

    timingRuntime.beginContentCalibration(nowMs, true);
    const startMode = autoContentCalibrationStartMode(queries.probeCalibrationExhausted(nowMs));
    if (startMode === 'primed') calibration.startFromPrimed(nowMs);
    else calibration.start(nowMs);
    effects.reportTimingStatus();
  }

  function contentValidationPathReady(nowMs: number) {
    const robotRoute = queries.robotRouteActive();
    if (!contentValidationPathPrerequisitesReady({
      enabled: CONTENT_VALIDATION_ENABLED,
      takeBlocked: queries.takeBlocksCalibration(),
      bootProbeSettled: queries.bootProbeSettled(nowMs),
      robotRouteActive: robotRoute,
      robotEvidenceMappingReady: !robotRoute || queries.robotContentEvidenceMappingReady(nowMs),
      sessionActive: session.active,
      calibrationCollecting: calibration.collecting,
    })) return false;




    const confirmed = calibration.confirmedResult;
    const appliedKind = queries.appliedCalibrationKind();
    if (!contentValidationAuthorityReady({
      appliedKind,
      hasConfirmedResult: confirmed !== null,
      calibrationStale:
        appliedKind === 'content' && confirmed !== null && queries.calibrationIsStale(),
    })) return false;

    const timeline = queries.currentTimelineStatus(nowMs);
    return contentValidationLivePathReady({
      backingConnected: backingRuntime.connected(),
      micControlConnected: micRuntime.controlConnected(),
      streamsFlowing: queries.bothStreamsFlowing(nowMs),
      timelineConnected: Boolean(timeline.connected),
      timelinePlaying: Number(timeline.state) === 1,
    });
  }

  function maybeValidateContentCalibration(nowMs: number) {
    syncContentValidationBaseline(nowMs);
    if (!contentCalibrationValidator.hasBaseline) return;

    const state = contentCalibrationValidator.status(nowMs).state;
    if (!contentValidationPathReady(nowMs)) {
      if (contentCalibrationValidator.collecting || state === 'suspect') {
        contentCalibrationValidator.cancel(nowMs);
      }
      return;
    }



    contentCalibrationValidator.tick(nowMs);
    contentCalibrationValidator.maybeStart(nowMs);
  }
  return {
    clearBaseline: clearContentValidationBaseline,
    syncBaseline: syncContentValidationBaseline,
    cancelValidation: cancelActiveContentValidation,
    stepAuto: maybeAutoCalibrate,
    validationPathReady: contentValidationPathReady,
    stepValidation: maybeValidateContentCalibration,
  } as const;
}

export type RelayCalibrationLifecycleDependencies = {
  readonly mix: Readonly<Pick<AudioSession, 'active' | 'stop'>>;
  readonly calibration: Readonly<Pick<CalibrationSession,
    'collecting' | 'fail' | 'reset' | 'beginExternalRecalibration'>>;
  readonly timing: Readonly<Pick<TimingRuntime,
    'clearCalibrationKind' | 'resetAutoCalibrationSchedule' | 'beginBootProbe'>>;
  readonly probe: Readonly<Pick<BootProbeRuntime, 'clear' | 'resetCorrelations'>>;
  // The original coordinators ignore both command return values.
  readonly backing: Readonly<{ cancelGrace(): void; retireRobotRoute(): void }>;
  readonly offset: Readonly<Pick<RobotPlayerOffsetTracker, 'reset'>>;
  readonly contentTimeline: Readonly<Pick<RobotContentTimelineMapper, 'reset'>>;
  readonly commands: Readonly<{
    clearContentValidation(): void;
    syncAppliedCalibration(): void;
    clearRobotContentTransition(): void;
    abandonProbeRun(): void;
    maybeStartProbeCalibration(nowMs: number): void;
  }>;
  readonly effects: Readonly<{
    endTakeMix(): void;
    reportTimingStatus(): void;
    reportSourceStatus(): void;
    reportStatus(): void;
    resetMicAudibility(): void;
    resetMicLevel(): void;
  }>;
};

/** Existing cross-domain coordinators own ordering; canonical owners retain state. */
export function createRelayCalibrationLifecycle(dependencies: RelayCalibrationLifecycleDependencies) {
  const session = dependencies.mix;
  const calibration = dependencies.calibration;
  const timingRuntime = dependencies.timing;
  const bootProbeRuntime = dependencies.probe;
  const backingRuntime = dependencies.backing;
  const robotPlayerOffset = dependencies.offset;
  const robotContentTimeline = dependencies.contentTimeline;
  const commands = dependencies.commands;
  const effects = dependencies.effects;
  const micTimingInvalidationCoordinator = createRelayMicTimingInvalidationCoordinator({
    clearBootCalibration: () => clearBootCalibrationState(),
    clearContentValidation: () => commands.clearContentValidation(),
    invalidateCalibration: (message) => {
      if (calibration.collecting) calibration.fail(message);
      else calibration.reset();
    },
    clearTimingKind: () => timingRuntime.clearCalibrationKind(),
    resetAutoCalibrationSchedule: () => timingRuntime.resetAutoCalibrationSchedule(),
    syncAppliedCalibration: () => { commands.syncAppliedCalibration(); },
    reportTimingStatus: () => effects.reportTimingStatus(),
    reportSourceStatus: () => effects.reportSourceStatus(),
  });

  const liveSourceStopCoordinator = createRelayLiveSourceStopCoordinator({
    cancelBackingGrace: () => backingRuntime.cancelGrace(),
    retireRobotRoute: () => backingRuntime.retireRobotRoute(),
    sessionActive: () => session.active,
    endTakeMix: () => effects.endTakeMix(),
    clearBootCalibration: () => clearBootCalibrationState(),
    clearContentValidation: () => commands.clearContentValidation(),
    resetRobotPlayerOffset: () => robotPlayerOffset.reset(),
    resetRobotContentTimeline: () => robotContentTimeline.reset(),
    clearRobotContentTransition: () => commands.clearRobotContentTransition(),
    stopSession: () => session.stop(),
    resetCalibration: () => calibration.reset(),
    clearTimingKind: () => timingRuntime.clearCalibrationKind(),
    resetAutoCalibrationSchedule: () => timingRuntime.resetAutoCalibrationSchedule(),
    reportTimingStatus: () => effects.reportTimingStatus(),
    reportSourceStatus: () => effects.reportSourceStatus(),
    reportStatus: () => effects.reportStatus(),
  });

  const manualBootRecalibrationCoordinator = createRelayManualBootRecalibrationCoordinator({
    clearContentValidation: () => commands.clearContentValidation(),
    beginExternalRecalibration: () => calibration.beginExternalRecalibration(),
    beginManualBootProbe: () => timingRuntime.beginBootProbe(false),
    abandonProbeRun: () => commands.abandonProbeRun(),
    resetProbeCorrelations: () => bootProbeRuntime.resetCorrelations(),
    syncAppliedCalibration: () => commands.syncAppliedCalibration(),
    maybeStartProbeCalibration: (nowMs) => commands.maybeStartProbeCalibration(nowMs),
    reportTimingStatus: () => effects.reportTimingStatus(),
    reportSourceStatus: () => effects.reportSourceStatus(),
  });

  function clearBootCalibrationState() {
    bootProbeRuntime.clear();
  }

  function invalidateMicTiming(message: string) {
    micTimingInvalidationCoordinator.invalidate(message);
  }

  function stopLiveSource() {
    liveSourceStopCoordinator.stop();
    effects.resetMicAudibility();
    effects.resetMicLevel();
  }

  function restartManualBootCalibration(nowMs: number) {
    manualBootRecalibrationCoordinator.restart(nowMs);
  }

  return { invalidateMicTiming, stopLiveSource, restartManualBootCalibration } as const;
}
