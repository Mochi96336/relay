import type { AudioSession } from './audio-session.js';
import type { BackingRuntime } from './backing-runtime.js';
import type { BootProbeRuntime } from './boot-probe-runtime.js';
import type { CalibrationApplicability } from './calibration-applicability.js';
import type { MicAudibilityMonitor } from './mic-audibility-monitor.js';
import type { MicCaptureDeliveryMonitor } from './mic-capture-delivery.js';
import type { MicClockDriftEstimator } from './mic-clock-drift-estimator.js';
import type { MicLevelMonitor } from './mic-level-monitor.js';
import type { MicRuntime } from './mic-runtime.js';
import type { ParticipantSession } from './participant-session.js';
import type { createMonitorSocketTransport } from './relay-socket-server.js';
import { buildReadiness } from './readiness.js';
import type { ProductStatusFacts, RemoteStatusFacts, RobotPlayerError } from './relay-status-projection.js';
import type { RobotPlayerOffsetTracker } from './robot-player-offset.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import type { TakeController } from './take-controller.js';
import type { TimingCalibrationKind } from './timing-runtime.js';

/** Existing policy queries remain with their domain/server owners. */
export type RelayReadinessProductReaders = {
  readonly mix: Pick<AudioSession,
    'active' | 'requestedMicAdvanceMs' | 'appliedMicAdvanceMs' | 'micFrontierCorrectionMs'
  > & { readonly alignment: Pick<AudioSession['alignment'], 'calibratedMicLagMs'> };
  readonly participants: Pick<ParticipantSession, 'snapshot'>;
  readonly backing: Pick<BackingRuntime<unknown>, 'armed' | 'connected' | 'sampleRate' | 'isRobot'>;
  readonly mic: {
    readonly runtime: Pick<MicRuntime,
      'connected' | 'streaming' | 'flowObserved' | 'startupTimedOut'
      | 'controlConnected' | 'freshUplinkHealthPayload'
    >;
    readonly audibility: Pick<MicAudibilityMonitor, 'degraded'>;
    readonly level: Pick<MicLevelMonitor, 'warning'>;
  };
  readonly source: Pick<SourceRuntime<SourceRuntimeSocket>, 'connected'>;
  readonly song: {
    readonly runtime: {
      statusPayload(nowMs: number): {
        readonly connected?: unknown; readonly videoId?: unknown;
        readonly state?: unknown; readonly ageMs?: unknown;
      };
      roomStatusPayload(nowMs: number): ProductStatusFacts['room'];
    };
    hasSong(nowMs: number): boolean;
  };
  readonly take: Pick<TakeController, 'statusPayload'>;
  readonly media: {
    backingPlayable(nowMs: number): boolean;
    micPlayable(nowMs: number): boolean;
  };
  readonly robot: {
    readonly playerError: RobotPlayerError | null;
    readonly offset: Pick<RobotPlayerOffsetTracker, 'offsetMs'>;
    routeActive(): boolean;
    deltaFresh(nowMs: number): boolean;
    probeTimingActive(): boolean;
    contentEvidenceReady(nowMs: number): boolean;
  };
  readonly timing: {
    readonly calibration: { status(): { readonly state?: unknown } };
    readonly probe: Pick<BootProbeRuntime, 'correlations' | 'calibrationResult'>;
    applicability(): CalibrationApplicability;
    isStale(): boolean;
    appliedKind(): TimingCalibrationKind;
    calibrationInProgress(nowMs: number): boolean;
    bootProbeInProgress(nowMs: number): boolean;
  };
};

/** Readiness/product share queries, not cached snapshots or domain settlement. */
function createReadinessProductFacts(readers: RelayReadinessProductReaders) {
  function readinessRouteMode(nowMs: number) {
    if (readers.robot.routeActive()) return 'robot' as const;
    if (readers.backing.armed()) return 'legacy' as const;
    // A Song expects backing even before a concrete route has announced itself.
    if (readers.song.hasSong(nowMs)) return 'song' as const;
    return 'idle' as const;
  }

  function readiness(nowMs: number) {
    const timeline = readers.song.runtime.statusPayload(nowMs);
    const calibrationStatus = readers.timing.calibration.status();
    const timelineState = Number(timeline.state);

    return buildReadiness({
      routeMode: readinessRouteMode(nowMs),
      backingConnected: readers.backing.connected(),
      backingStreaming: readers.media.backingPlayable(nowMs),
      backingSampleRate: readers.backing.sampleRate,
      backingIsRobot: readers.backing.isRobot,
      micConnected: readers.mic.runtime.connected(),
      micStreaming: readers.media.micPlayable(nowMs),
      micArriving: readers.mic.runtime.streaming(nowMs),
      micFlowObserved: readers.mic.runtime.flowObserved(),
      micStartupTimedOut: readers.mic.runtime.startupTimedOut(nowMs),
      robotSourceConnected: readers.source.connected(),
      sessionActive: readers.mix.active,
      timelineConnected: Boolean(timeline.connected && timeline.videoId),
      timelineState: Number.isFinite(timelineState) ? timelineState : null,
      playerOffsetMs: readers.robot.offset.offsetMs(nowMs),
      playerOffsetFresh: readers.robot.deltaFresh(nowMs),
      calibrationState: String(calibrationStatus.state ?? 'idle'),
      // Applicability owns its original independent clock. A held measurement
      // remains valid; preserve its short circuit before reading alignment.
      calibrationValid: readers.timing.applicability() !== 'revoke'
        && readers.mix.alignment.calibratedMicLagMs !== null,
      calibrationStale: readers.timing.isStale(),
      calibrationKind: readers.timing.appliedKind(),
      probeCorrelation: readers.timing.probe.correlations,
      bootCalibration: readers.timing.probe.calibrationResult,
    });
  }

  function product(nowMs: number): ProductStatusFacts {
    const snapshotReadiness = readiness(nowMs);
    const participantSnapshot = readers.participants.snapshot();
    const micOwner = participantSnapshot.micOwnerId
      ? participantSnapshot.participants.find((participant) => participant.id === participantSnapshot.micOwnerId) ?? null
      : null;
    const room = readers.song.runtime.roomStatusPayload(nowMs);
    const timelineAgeMs = Number(readers.song.runtime.statusPayload(nowMs).ageMs);
    const takeStatus = readers.take.statusPayload();
    const alignment = readers.mix.alignment;
    const calibrationStatus = readers.timing.calibration.status();

    return {
      readiness: snapshotReadiness,
      participantCount: participantSnapshot.participants.length,
      micOwnerId: participantSnapshot.micOwnerId,
      micOwnerNickname: micOwner?.nickname ?? null,
      publisherControlConnected: readers.mic.runtime.controlConnected(),
      freshMicUplink: readers.mic.runtime.freshUplinkHealthPayload(nowMs),
      micAudibilityDegraded: readers.mic.audibility.degraded,
      micLevelWarning: readers.mic.level.warning,
      robotPlayerError: readers.robot.playerError,
      room,
      timelineAgeMs,
      takeStatus,
      timing: {
        calibratedMicLagMs: alignment.calibratedMicLagMs,
        calibrationState: String(calibrationStatus.state ?? 'idle'),
        calibrationActive: readers.timing.calibrationInProgress(nowMs),
        calibrationStale: readers.timing.isStale(),
        requestedMicAdvanceMs: readers.mix.requestedMicAdvanceMs,
        appliedMicAdvanceMs: readers.mix.appliedMicAdvanceMs,
        micFrontierCorrectionMs: readers.mix.micFrontierCorrectionMs,
        robotRouteActive: readers.robot.routeActive(),
        appliedCalibrationKind: readers.timing.appliedKind(),
        robotProbeTimingActive: readers.robot.probeTimingActive(),
        bootProbeActive: readers.timing.bootProbeInProgress(nowMs),
        contentEvidenceReady: readers.robot.contentEvidenceReady(nowMs),
        robotDeltaFresh: readers.robot.deltaFresh(nowMs),
      },
    };
  }

  return { readiness, product };
}

/** Live query ports, not a cached snapshot or a second domain authority. */
export type RelayStatusReaders = RelayReadinessProductReaders & {
  readonly mixSampleRate: number;
  readonly mix: RelayReadinessProductReaders['mix'] & Pick<AudioSession,
    'health' | 'active' | 'micGainDb' | 'micConcealedSampleCount' | 'micClockTrimPpm'
    | 'micFrontierCorrectionMs' | 'micTimelineFoldCount' | 'lastMicTimelineFold'
  >;
  readonly monitor: Pick<ReturnType<typeof createMonitorSocketTransport>, 'recentDrops' | 'droppedFrames'>;
  readonly backing: RelayReadinessProductReaders['backing'] & Pick<BackingRuntime<unknown>, 'lastFrameAt'>;
  readonly mic: RelayReadinessProductReaders['mic'] & {
    readonly runtime: RelayReadinessProductReaders['mic']['runtime'] & Pick<MicRuntime,
      'mediaPath' | 'frameAgeMs' | 'sampleRate' | 'uplinkHealthPayload' | 'receiverStats' | 'retransmitStats'
    >;
    readonly audibility: RelayReadinessProductReaders['mic']['audibility'] & Pick<MicAudibilityMonitor, 'status'>;
    readonly level: RelayReadinessProductReaders['mic']['level'] & Pick<MicLevelMonitor, 'status'>;
    readonly drift: Pick<MicClockDriftEstimator, 'estimate' | 'anchorExcessMs'>;
    readonly captureDelivery: Pick<MicCaptureDeliveryMonitor, 'status'>;
  };
};

function frameAgeMs(atMs: number, nowMs: number) {
  return Number.isFinite(atMs) ? Math.round(nowMs - atMs) : null;
}

/** Collection preserves getter order and existing read-time housekeeping. */
export function createRelayStatusFacts(readers: RelayStatusReaders) {
  const collectors = createReadinessProductFacts(readers);
  function remote(nowMs: number): RemoteStatusFacts {
    const alignment = readers.mix.alignment;
    const snapshot = readers.participants.snapshot();
    const mixHealth = readers.mix.health();
    const monitorDrops = readers.monitor.recentDrops(nowMs);
    const readiness = collectors.readiness(nowMs);

    return {
      nowMs,
      readiness,
      participants: {
        total: snapshot.participants.length,
        connected: snapshot.participants.filter((participant) => participant.connected).length,
      },
      backingFrameAgeMs: frameAgeMs(readers.backing.lastFrameAt, nowMs),
      calibratedMicLagMs: alignment.calibratedMicLagMs,
      robotPlayerError: readers.robot.playerError,
      mixSampleRate: readers.mixSampleRate,
      mix: {
        active: readers.mix.active,
        health: mixHealth,
        monitorDroppedFrames: readers.monitor.droppedFrames,
        monitorRecentDroppedFrames: monitorDrops.frames,
        monitorRecentDroppingListeners: monitorDrops.listeners,
      },
      mic: {
        mediaPath: readers.mic.runtime.mediaPath(),
        frameAgeMs: readers.mic.runtime.frameAgeMs(nowMs),
        sampleRate: readers.mic.runtime.sampleRate,
        captureAndSender: readers.mic.runtime.uplinkHealthPayload(nowMs),
        receiverTransport: readers.mic.runtime.receiverStats(),
        receiverRetransmit: readers.mic.runtime.retransmitStats(),
        audibility: readers.mic.audibility.status(),
        level: readers.mic.level.status(),
        micGainDb: readers.mix.micGainDb,
        concealedSamples: readers.mix.micConcealedSampleCount,
        clockDrift: readers.mic.drift.estimate(),
        clockTrimPpm: readers.mix.micClockTrimPpm,
        anchorExcessMs: readers.mic.drift.anchorExcessMs(),
        frontierCorrectionMs: readers.mix.micFrontierCorrectionMs,
        timelineFolds: readers.mix.micTimelineFoldCount,
        lastTimelineFold: readers.mix.lastMicTimelineFold,
        captureDelivery: readers.mic.captureDelivery.status(),
      },
    };
  }

  return { remote, readiness: collectors.readiness, product: collectors.product };
}
