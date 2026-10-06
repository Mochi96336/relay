import type { AudioSession } from './audio-session.js';
import type { BackingRuntime } from './backing-runtime.js';
import type { CalibrationContext, CalibrationSession } from './calibration-session.js';
import type { ContentCalibrationValidator } from './content-calibration-validator.js';
import type { PcmFrame } from './pcm-frame.js';
import { createRelayRobotActivationCoordinator } from './relay-robot-activation-coordinator.js';
import { createRelayRobotContentMappingRevocationCoordinator } from './relay-robot-content-mapping-revocation-coordinator.js';
import { createRelayRobotContentTransitionCommitCoordinator } from './relay-robot-content-transition-commit-coordinator.js';
import { createRelayRobotDisconnectCoordinator } from './relay-robot-disconnect-coordinator.js';
import { createRelayRobotLegacyCalibrationDropCoordinator } from './relay-robot-legacy-calibration-drop-coordinator.js';
import { createRelaySourceSeekTransactionCoordinator } from './relay-source-seek-transaction-coordinator.js';
import type { RobotContentTimelineMapper } from './robot-content-timeline.js';
import type { RobotContentTransitionRuntime } from './robot-content-transition-runtime.js';
import { robotContentAnchorEvidenceUsable } from './robot-content-transition.js';
import type { RobotPlayerOffsetTracker } from './robot-player-offset.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import type { TimingRuntime } from './timing-runtime.js';

export type RelayRobotMappingDependencies = {
  readonly mixSampleRate: number;
  readonly transitionHistorySamples: number;
  readonly maxCaptureGapMs: number;
  readonly backing: Readonly<Pick<BackingRuntime<unknown>, 'isRobot'>>;
  readonly source: Readonly<Pick<SourceRuntime<SourceRuntimeSocket>, 'connected'>>;
  readonly offset: Readonly<Pick<RobotPlayerOffsetTracker, 'offsetMs' | 'isFresh'>>;
  readonly timeline: Readonly<Pick<RobotContentTimelineMapper,
    'isReady' | 'needsBackingBoundary' | 'mapBackingStart'>>;
  readonly calibration: Readonly<Pick<CalibrationSession,
    'confirmedResult' | 'collecting' | 'transitionEvidence'>>;
  readonly timing: Readonly<Pick<TimingRuntime, 'calibrationKind'>>;
  readonly queries: {
    context(): CalibrationContext;
    appliedKind(): ReturnType<TimingRuntime['appliedCalibrationKind']>;
    calibrationIsStale(): boolean;
  };
};

/** Live orchestration queries; no cached authority or constructor side effects. */
function createRobotMappingQueries(dependencies: RelayRobotMappingDependencies) {
  function routeActive() {
    // The route is physical, not the configuration of a measurement strategy.
    return dependencies.backing.isRobot || dependencies.source.connected();
  }

  function deltaFresh(nowMs: number) {
    // offsetMs performs existing expiration housekeeping. Keep the query order.
    return dependencies.source.connected()
      && dependencies.offset.offsetMs(nowMs) !== null
      && dependencies.offset.isFresh(nowMs);
  }

  function contentMappingReady(nowMs: number) {
    if (!routeActive()) return true;
    return dependencies.source.connected()
      && dependencies.timeline.isReady(dependencies.queries.context(), nowMs);
  }

  function contentEvidenceReady(nowMs: number) {
    if (!contentMappingReady(nowMs)) return false;
    return !dependencies.timeline.needsBackingBoundary(dependencies.queries.context());
  }

  function mapBackingStart(startSample: number, nowMs: number) {
    if (!dependencies.backing.isRobot) return startSample;
    return dependencies.timeline.mapBackingStart(startSample, dependencies.queries.context(), nowMs);
  }

  function followerSeekMayPreserveMapping(nowMs: number) {
    if (!dependencies.backing.isRobot && !dependencies.source.connected()) return true;
    const context = dependencies.queries.context();
    if (!dependencies.source.connected() || !dependencies.timeline.isReady(context, nowMs)) return false;

    const confirmedContentAuthority = dependencies.queries.appliedKind() === 'content'
      && dependencies.calibration.confirmedResult !== null
      && !dependencies.queries.calibrationIsStale();
    if (confirmedContentAuthority) return true;

    if (dependencies.timing.calibrationKind !== 'content' || !dependencies.calibration.collecting) return false;
    return robotContentAnchorEvidenceUsable(
      dependencies.calibration.transitionEvidence(dependencies.transitionHistorySamples),
      dependencies.mixSampleRate,
      dependencies.maxCaptureGapMs,
    );
  }

  return { routeActive, deltaFresh, contentMappingReady, contentEvidenceReady,
    mapBackingStart, followerSeekMayPreserveMapping };
}

export type RelayRobotMappingLifecycleDependencies<TSocket extends { readonly readyState: number }> = {
  readonly socketOpenState: number;
  readonly offset: Readonly<Pick<RobotPlayerOffsetTracker, 'reset'>>;
  readonly timeline: Readonly<Pick<RobotContentTimelineMapper,
    'reset' | 'matchesPlaybackRate' | 'committedDeltaMs' | 'currentDeltaMs'
    | 'referenceDeltaMs' | 'needsBackingBoundary'>>;
  // The generation remains SourceRuntime authority; this command deliberately
  // discards its return value, just as the existing revocation port does.
  readonly source: { invalidateMapping(): void };
  readonly calibration: Readonly<Pick<CalibrationSession,
    'confirmedResult' | 'collecting' | 'discardPrimedContent' | 'fail'>>;
  readonly transition: Readonly<Pick<RobotContentTransitionRuntime,
    'clear' | 'begin' | 'reconcileWithFreshDelta' | 'noteBackingFrame' | 'requestBackingBoundary'>>;
  readonly backing: Readonly<Pick<BackingRuntime<TSocket>, 'isRobot' | 'socket' | 'sampleRate'>>;
  readonly mix: Readonly<Pick<AudioSession, 'backingGeneration' | 'backingTotalSamples'>>;
  readonly queries: {
    context(): CalibrationContext;
    appliedKind(): ReturnType<TimingRuntime['appliedCalibrationKind']>;
    calibrationIsStale(): boolean;
    currentPlaybackRate(nowMs: number): number;
  };
  readonly effects: {
    clearContentValidation(): void;
    syncAppliedCalibration(): void;
    reportSourceStatus(): void;
    reportTimingStatus(): void;
    sendBoundaryRequest(target: TSocket, message: {
      type: 'backing-sample-boundary-request'; requestId: number;
    }): void;
  };
};

/** Mapping lifecycle ordering; all state and worker authority stay in domain owners. */
export function createRelayRobotMappingLifecycle<TSocket extends { readonly readyState: number }>(
  dependencies: RelayRobotMappingLifecycleDependencies<TSocket>,
) {
  function clearTransition() {
    dependencies.transition.clear();
  }

  const revocation = createRelayRobotContentMappingRevocationCoordinator({
    resetPlayerOffset: () => dependencies.offset.reset(),
    resetContentTimeline: () => dependencies.timeline.reset(),
    clearContentTransition: () => clearTransition(),
    invalidateSourceMapping: () => dependencies.source.invalidateMapping(),
    discardPrimedContent: () => dependencies.calibration.discardPrimedContent(),
    clearContentValidation: () => dependencies.effects.clearContentValidation(),
    abortCalibrationIfCollecting: (reason) => {
      if (dependencies.calibration.collecting) dependencies.calibration.fail(reason);
    },
    syncAppliedCalibration: () => { dependencies.effects.syncAppliedCalibration(); },
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
    reportTimingStatus: () => dependencies.effects.reportTimingStatus(),
  });

  function revoke(reason: string) {
    revocation.revoke(reason);
  }

  function revokeOnRateChange(playbackRate: unknown) {
    const rate = Number(playbackRate);
    if (!Number.isFinite(rate) || rate <= 0) return false;
    if (dependencies.timeline.matchesPlaybackRate(rate)) return false;

    revoke('The room changed playback rate during calibration.'
      + ' Rebuilding the Robot content mapping before calibration retries.');
    return true;
  }

  function beginTransition(
    fromMediaTime: number,
    toMediaTime: number,
    preDeltaMs: number,
    referenceDeltaMs: number,
    context: CalibrationContext,
    nowMs: number,
  ) {
    const confirmedReferenceLagMs = dependencies.queries.appliedKind() === 'content'
      && !dependencies.queries.calibrationIsStale()
      ? dependencies.calibration.confirmedResult?.micLagMs ?? null
      : null;
    dependencies.transition.begin({
      fromMediaTime,
      toMediaTime,
      preDeltaMs,
      referenceDeltaMs,
      context,
      confirmedReferenceLagMs,
      playbackRate: dependencies.queries.currentPlaybackRate(nowMs),
    }, nowMs);
  }

  function reconcile(context: CalibrationContext, nowMs: number) {
    const confirmedReferenceLagMs = dependencies.queries.appliedKind() === 'content'
      && !dependencies.queries.calibrationIsStale()
      ? dependencies.calibration.confirmedResult?.micLagMs ?? null
      : null;
    return dependencies.transition.reconcileWithFreshDelta({
      context,
      committedDeltaMs: dependencies.timeline.committedDeltaMs,
      freshDeltaMs: dependencies.timeline.currentDeltaMs,
      referenceDeltaMs: dependencies.timeline.referenceDeltaMs,
      confirmedReferenceLagMs,
      playbackRate: dependencies.queries.currentPlaybackRate(nowMs),
    }, nowMs);
  }

  function noteBackingFrame(frame: PcmFrame, samples: Int16Array, start: number, nowMs: number) {
    dependencies.transition.noteBackingFrame({
      frameGeneration: frame.generation,
      firstSampleIndex: frame.firstSampleIndex,
      sourceSampleCount: Math.floor(frame.pcm.byteLength / 2),
      sourceSampleRate: dependencies.backing.sampleRate,
      samples,
      start,
      backingTotalSamples: dependencies.mix.backingTotalSamples,
    }, nowMs);
  }

  function requestBoundary(nowMs: number) {
    const context = dependencies.queries.context();
    if (!dependencies.timeline.needsBackingBoundary(context)) return false;
    if (!reconcile(context, nowMs)) return false;
    const target = dependencies.backing.socket;
    const backingGeneration = dependencies.mix.backingGeneration;
    if (
      !dependencies.backing.isRobot
      || target?.readyState !== dependencies.socketOpenState
      || backingGeneration === null
    ) return false;

    const request = dependencies.transition.requestBackingBoundary(backingGeneration);
    if (request === null) return false;
    dependencies.effects.sendBoundaryRequest(target, {
      type: 'backing-sample-boundary-request',
      requestId: request.requestId,
    });
    return true;
  }

  return { clearTransition, revoke, revokeOnRateChange, beginTransition,
    reconcile, noteBackingFrame, requestBoundary };
}

/** One inert composition shares the canonical domain ports across both boundaries. */
export function createRelayRobotMappingOrchestration<TSocket extends { readonly readyState: number }>(
  dependencies: RelayRobotMappingDependencies & RelayRobotMappingLifecycleDependencies<TSocket>
    & RelayRobotMappingCommitDependencies & RelayRobotSourceLifecycleDependencies<TSocket>,
) {
  const queries = createRobotMappingQueries(dependencies);
  const lifecycle = createRelayRobotMappingLifecycle(dependencies);
  const commit = createRelayRobotMappingCommit(dependencies);
  const source = createRelayRobotSourceLifecycle(dependencies, {
    routeActive: queries.routeActive,
    clearTransition: lifecycle.clearTransition,
    beginTransition: lifecycle.beginTransition,
    revoke: lifecycle.revoke,
  });
  return { ...queries, ...lifecycle, ...commit, ...source };
}

export type RelayRobotMappingCommitDependencies = {
  readonly timeline: Readonly<Pick<RobotContentTimelineMapper, 'noteBackingBoundary' | 'mapBackingStart'>>;
  readonly calibration: Readonly<Pick<CalibrationSession, 'restartWorkingEvidence'>>;
  readonly validator: Readonly<Pick<ContentCalibrationValidator, 'collecting' | 'cancel'>>;
  readonly effects: Readonly<{
    feedBackingEvidence(samples: Int16Array, start: number, nowMs: number): void;
  }>;
};

/** Commit effect composition only; boundary acceptance and evidence remain canonical owner commands. */
export function createRelayRobotMappingCommit(dependencies: RelayRobotMappingCommitDependencies) {
  return createRelayRobotContentTransitionCommitCoordinator<CalibrationContext>({
    noteBackingBoundary: (boundarySample, context, nowMs) =>
      dependencies.timeline.noteBackingBoundary(boundarySample, context, nowMs),
    restartWorkingEvidence: (nowMs) => dependencies.calibration.restartWorkingEvidence(nowMs),
    contentValidationCollecting: () => dependencies.validator.collecting,
    cancelContentValidation: (nowMs) => dependencies.validator.cancel(nowMs),
    feedBackingEvidence: (samples, start, nowMs) => {
      dependencies.effects.feedBackingEvidence(samples, start, nowMs);
    },
    mapBackingStart: (start, context, nowMs) =>
      dependencies.timeline.mapBackingStart(start, context, nowMs),
  });
}

export type RelayRobotSourceLifecycleDependencies<TSocket> = {
  // Commands deliberately discard owner return values; identity stays canonical.
  readonly source: { isActive(socket: TSocket): boolean; detachRobot(socket: TSocket): void };
  readonly take: {
    noteQualityEvent(event: 'robot-source-replaced' | 'robot-source-connected' | 'robot-source-disconnected'): void;
  };
  readonly mix: Readonly<Pick<AudioSession, 'active'>>;
  readonly offset: Readonly<Pick<RobotPlayerOffsetTracker, 'reset'>>;
  readonly timeline: Readonly<Pick<RobotContentTimelineMapper, 'reset'>>;
  readonly calibration: Readonly<Pick<CalibrationSession, 'collecting' | 'fail' | 'reset'>>;
  readonly timing: Readonly<Pick<TimingRuntime,
    'calibrationKind' | 'clearCalibrationKind' | 'resetAutoCalibrationSchedule'>>;
  readonly queries: { bootProbeSettled(): boolean };
  readonly commands: { abandonProbeRun(): void };
  readonly effects: {
    notifyPreviousReplaced(previous: TSocket): void;
    clearContentValidation(): void;
    syncAppliedCalibration(): void;
    reportSourceStatus(): void;
    reportTimingStatus(): void;
  };
};

export type RelayRobotSourceMappingMethods = Readonly<Pick<
  ReturnType<typeof createRelayRobotMappingLifecycle>, 'clearTransition' | 'beginTransition' | 'revoke'
>> & { readonly routeActive: () => boolean };

/** Source effect composition; admission, generation, mapping policy and clocks stay with their owners. */
export function createRelayRobotSourceLifecycle<TSocket>(
  dependencies: RelayRobotSourceLifecycleDependencies<TSocket>,
  mapping: RelayRobotSourceMappingMethods,
) {
  const legacyDrop = createRelayRobotLegacyCalibrationDropCoordinator({
    robotRouteActive: () => mapping.routeActive(),
    calibrationKind: () => dependencies.timing.calibrationKind,
    bootProbeSettled: () => dependencies.queries.bootProbeSettled(),
    clearContentValidationBaseline: () => dependencies.effects.clearContentValidation(),
    resetCalibration: () => dependencies.calibration.reset(),
    clearCalibrationKind: () => dependencies.timing.clearCalibrationKind(),
    resetAutoCalibrationSchedule: () => dependencies.timing.resetAutoCalibrationSchedule(),
    syncAppliedCalibration: () => { dependencies.effects.syncAppliedCalibration(); },
  });
  const activation = createRelayRobotActivationCoordinator<TSocket>({
    notifyPreviousReplaced: (previous) => dependencies.effects.notifyPreviousReplaced(previous),
    noteQualityEvent: (event) => dependencies.take.noteQualityEvent(event),
    abandonProbeRun: () => dependencies.commands.abandonProbeRun(),
    sessionActive: () => dependencies.mix.active,
    resetPlayerOffset: () => dependencies.offset.reset(),
    resetContentTimeline: () => dependencies.timeline.reset(),
    clearContentTransition: () => mapping.clearTransition(),
    failCalibrationIfCollecting: () => {
      if (dependencies.calibration.collecting) {
        dependencies.calibration.fail('The Robot source changed during calibration. Start calibration again.');
      }
    },
    dropLegacyCalibrationForRobot: () => legacyDrop.drop(),
    syncAppliedCalibration: () => { dependencies.effects.syncAppliedCalibration(); },
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
    reportTimingStatus: () => dependencies.effects.reportTimingStatus(),
  });
  const disconnect = createRelayRobotDisconnectCoordinator<TSocket>({
    isActive: (socket) => dependencies.source.isActive(socket),
    noteDisconnected: () => dependencies.take.noteQualityEvent('robot-source-disconnected'),
    detach: (socket) => dependencies.source.detachRobot(socket),
    resetPlayerOffset: () => dependencies.offset.reset(),
    resetContentTimeline: () => dependencies.timeline.reset(),
    clearContentTransition: () => mapping.clearTransition(),
    abandonProbeRun: () => dependencies.commands.abandonProbeRun(),
    failCalibrationIfCollecting: () => {
      if (dependencies.calibration.collecting) {
        dependencies.calibration.fail('The Robot source changed during calibration. Start calibration again.');
      }
    },
    syncAppliedCalibration: () => dependencies.effects.syncAppliedCalibration(),
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
    reportTimingStatus: () => dependencies.effects.reportTimingStatus(),
  });
  const seek = createRelaySourceSeekTransactionCoordinator<CalibrationContext>({
    resetPlayerOffset: () => dependencies.offset.reset(),
    beginContentTransition: (fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs) => {
      mapping.beginTransition(fromMediaTime, toMediaTime, preDeltaMs, referenceDeltaMs, context, nowMs);
    },
    syncAppliedCalibration: () => { dependencies.effects.syncAppliedCalibration(); },
    reportSourceStatus: () => dependencies.effects.reportSourceStatus(),
    reportTimingStatus: () => dependencies.effects.reportTimingStatus(),
    revokeContentMapping: (reason) => mapping.revoke(reason),
  });
  return { activateSource: activation.activate, disconnectSource: disconnect.handle,
    dropLegacyCalibration: legacyDrop.drop, handleSourceSeek: seek.handle };
}
