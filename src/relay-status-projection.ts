import type { MicTimelineFold, MixHealth } from './audio-session.js';
import type { MicAudibilityMonitor } from './mic-audibility-monitor.js';
import type { MicCaptureDeliveryMonitor } from './mic-capture-delivery.js';
import type { MicClockDriftEstimator } from './mic-clock-drift-estimator.js';
import type { MicUplinkBacklog } from './mic-uplink-backlog.js';
import type { MicLevelMonitor, MicLevelWarning } from './mic-level-monitor.js';
import type { MicRuntime } from './mic-runtime.js';
import type { TakeControllerStatusPayload } from './take-controller.js';
import type { TimingCalibrationKind } from './timing-runtime.js';
import type { ReadinessSnapshot } from './readiness.js';
import { buildRelayObservationStatusV1 } from './observation-status.js';
import { buildProductViewModel } from './product-view-model.js';
import { deriveRemoteStatusHealth } from './remote-status.js';
import { youtubeErrorMeansUnplayable } from '../shared/robot-player-errors.js';

/**
 * Pure projections of Relay's runtime into its status contracts: /statusz,
 * the v1 observation contract, and ProductStatus.
 *
 * server.ts samples its runtimes once into a facts object, and these functions
 * turn that sample into each payload. Being pure is what lets every rule in a
 * contract be tested as behaviour instead of as server source text. It also
 * makes "one sampled snapshot" structural: a projection can read only what it
 * was handed, so readiness-owned facts cannot be re-read from a live runtime.
 */

/** What the Robot's player last said about a video it could not play. */
export type RobotPlayerError = { videoId: string; code: number };

export type RemoteStatusFacts = {
  /** When the sample was taken. /statusz reports it as uptime. */
  nowMs: number;
  /** The one readiness snapshot every readiness-owned field comes from. */
  readiness: ReadinessSnapshot;
  participants: { total: number; connected: number };
  backingFrameAgeMs: number | null;
  /** The alignment serving the mixer; null while it runs on the network estimate. */
  calibratedMicLagMs: number | null;
  robotPlayerError: RobotPlayerError | null;
  mixSampleRate: number;
  mix: {
    active: boolean;
    health: MixHealth;
    monitorDroppedFrames: number;
    monitorRecentDroppedFrames: number;
    monitorRecentDroppingListeners: number;
  };
  mic: {
    mediaPath: ReturnType<MicRuntime['mediaPath']>;
    frameAgeMs: number | null;
    sampleRate: number | null;
    captureAndSender: ReturnType<MicRuntime['uplinkHealthPayload']>;
    receiverTransport: ReturnType<MicRuntime['receiverStats']>;
    receiverRetransmit: ReturnType<MicRuntime['retransmitStats']>;
    audibility: ReturnType<MicAudibilityMonitor['status']>;
    level: ReturnType<MicLevelMonitor['status']>;
    micGainDb: number;
    concealedSamples: number;
    clockDrift: ReturnType<MicClockDriftEstimator['estimate']>;
    clockTrimPpm: number;
    anchorExcessMs: ReturnType<MicClockDriftEstimator['anchorExcessMs']>;
    frontierCorrectionMs: number;
    timelineFolds: number;
    lastTimelineFold: MicTimelineFold | null;
    captureDelivery: ReturnType<MicCaptureDeliveryMonitor['status']>;
    uplinkBacklog: ReturnType<MicUplinkBacklog['status']>;
  };
};

/**
 * The status another machine can poll.
 *
 * `/healthz` answers "is the Relay process up", which stays `true` through
 * every failure an unattended robot actually has: the browser died, the sink
 * vanished, the backing bridge stopped. This reports on the *route* instead.
 *
 * It reduces that to `ok` plus named faults so the poller does not have to
 * model Relay's internals. A fault is something that is definitely broken - a
 * connected client that stopped sending audio, or a robot route missing a
 * component - never merely "nobody is singing", which is what `idle` is for.
 * Warnings degrade quality without stopping audio, so they do not clear `ok`.
 *
 * Deliberately carries no nicknames or keys: it is unauthenticated on the LAN
 * like `/healthz`, so it reports counts and states only.
 */
export function projectRemoteStatus(facts: RemoteStatusFacts) {
  const { nowMs, readiness, mix, mic } = facts;
  const health = deriveRemoteStatusHealth(readiness);
  const components = readiness.components;

  return {
    ok: health.ok,
    state: health.state,
    faults: health.faults,
    warnings: health.warnings,
    uptimeMs: Math.round(nowMs),
    source: {
      backingConnected: components.backing.connected,
      backingStreaming: components.backing.streaming,
      backingSampleRate: components.backing.sampleRate,
      backingIsRobot: components.backing.robot,
      backingFrameAgeMs: facts.backingFrameAgeMs,
      micConnected: components.mic.connected,
      micStreaming: components.mic.streaming,
      // Mic PCM still arriving, playable or not. `micStreaming` is what the
      // room can hear, so the two apart mean the mix has fallen behind it.
      micArriving: components.mic.arriving,
      micMediaPath: mic.mediaPath,
      micFrameAgeMs: mic.frameAgeMs,
      participants: facts.participants.total,
      participantsConnected: facts.participants.connected,
    },
    robot: {
      route: components.route.mode === 'robot',
      sourceConnected: components.robotSource.connected,
      deltaFresh: components.player.offsetFresh,
      calibrationKind: components.calibration.kind,
      calibrationStale: components.calibration.stale,
      timingMode: facts.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      activeCalibratedMicLagMs: facts.calibratedMicLagMs,
      playerError: facts.robotPlayerError === null ? null : {
        ...facts.robotPlayerError,
        unplayable: youtubeErrorMeansUnplayable(facts.robotPlayerError.code),
      },
    },
    mix: {
      active: mix.active,
      ...mix.health,
      monitorDroppedFrames: mix.monitorDroppedFrames,
      monitorRecentDroppedFrames: mix.monitorRecentDroppedFrames,
      monitorRecentDroppingListeners: mix.monitorRecentDroppingListeners,
    },
    audio: {
      micMediaPath: mic.mediaPath,
      micSampleRate: mic.sampleRate,
      captureAndSender: mic.captureAndSender,
      receiverTransport: mic.receiverTransport,
      receiverRetransmit: mic.receiverRetransmit,
      micAudibility: mic.audibility,
      // The gain now, beside the gain the last window was measured at: a
      // change is judged at once but measured only when the next window closes.
      micLevel: { ...mic.level, micGainDb: mic.micGainDb },
      timeline: {
        micGapMs: mix.health.micGapMs,
        micConcealedMs: Math.round((mic.concealedSamples / facts.mixSampleRate) * 1000),
        micClockDrift: mic.clockDrift,
        micClockTrimPpm: mic.clockTrimPpm,
        micAnchorExcessMs: mic.anchorExcessMs,
        micHeadroomMs: mix.health.micHeadroomMs,
        micStarvedFrames: mix.health.micStarvedFrames,
        micFrontierCorrectionMs: Math.round(mic.frontierCorrectionMs),
        micTimelineFolds: mic.timelineFolds,
        lastMicTimelineFold: mic.lastTimelineFold,
      },
      micCaptureDelivery: mic.captureDelivery,
      micUplinkBacklog: mic.uplinkBacklog,
    },
  };
}

export type RemoteStatus = ReturnType<typeof projectRemoteStatus>;

/** The identity-free v1 observation contract, derived from /statusz. */
export function projectObservationStatusV1(
  remote: RemoteStatus,
  facts: { micLeaseHeld: boolean; micSampleRate: number | null },
  generatedAt?: string,
) {
  return buildRelayObservationStatusV1({
    workload: {
      id: 'relay',
      state: remote.state,
      ok: remote.ok,
      uptimeMs: remote.uptimeMs,
    },
    activity: {
      sessionActive: remote.mix.active,
      participants: {
        total: remote.source.participants,
        connected: remote.source.participantsConnected,
      },
      microphoneLease: {
        held: facts.micLeaseHeld,
        transportConnected: remote.source.micConnected,
      },
    },
    sources: {
      backing: {
        connected: remote.source.backingConnected,
        streaming: remote.source.backingStreaming,
        sampleRate: remote.source.backingSampleRate,
        robot: remote.source.backingIsRobot,
        frameAgeMs: remote.source.backingFrameAgeMs,
      },
      microphone: {
        connected: remote.source.micConnected,
        streaming: remote.source.micStreaming,
        sampleRate: facts.micSampleRate,
        frameAgeMs: remote.source.micFrameAgeMs,
      },
      robot: {
        routeActive: remote.robot.route,
        sourceConnected: remote.robot.sourceConnected,
        playerDeltaFresh: remote.robot.deltaFresh,
      },
    },
    calibration: {
      kind: remote.robot.calibrationKind === 'boot-probe'
        ? 'boot-probe'
        : remote.robot.calibrationKind === 'content'
          ? 'content'
          : 'none',
      stale: remote.robot.calibrationStale,
      timingMode: remote.robot.timingMode,
      activeCalibratedMicLagMs: remote.robot.activeCalibratedMicLagMs,
    },
    mix: remote.mix,
    issues: {
      faults: remote.faults,
      warnings: remote.warnings,
    },
  }, generatedAt);
}

export type ProductStatusFacts = {
  readiness: ReadinessSnapshot;
  participantCount: number;
  micOwnerId: string | null;
  micOwnerNickname: string | null;
  publisherControlConnected: boolean;
  /**
   * The one fresh Mic health report every browser-quality fact comes from,
   * or null when the browser has not reported recently.
   */
  freshMicUplink: ReturnType<MicRuntime['freshUplinkHealthPayload']>;
  micAudibilityDegraded: boolean;
  micLevelWarning: MicLevelWarning | null;
  robotPlayerError: RobotPlayerError | null;
  room: { videoId?: unknown; connected?: unknown; state?: unknown; handoffState?: unknown };
  /**
   * Raw age of the song clock. `room.connected` answers whether the clock is
   * authoritative right now, on a window tight enough for alignment; telling
   * a singer their playback is unavailable is a slower question.
   */
  timelineAgeMs: number;
  takeStatus: TakeControllerStatusPayload;
  timing: {
    calibratedMicLagMs: number | null;
    calibrationState: string;
    calibrationActive: boolean;
    calibrationStale: boolean;
    requestedMicAdvanceMs: number;
    appliedMicAdvanceMs: number;
    micFrontierCorrectionMs: number;
    robotRouteActive: boolean;
    /** The authority serving the mixer, not a replacement being measured. */
    appliedCalibrationKind: TimingCalibrationKind;
    robotProbeTimingActive: boolean;
    bootProbeActive: boolean;
    contentEvidenceReady: boolean;
    robotDeltaFresh: boolean;
  };
};

export function projectProductStatus(facts: ProductStatusFacts) {
  const { room, timing, freshMicUplink, robotPlayerError } = facts;
  const roomState = Number(room.state);
  const take = facts.takeStatus.take;

  return buildProductViewModel({
    readiness: facts.readiness,
    participantCount: facts.participantCount,
    micOwnerId: facts.micOwnerId,
    micOwnerNickname: facts.micOwnerNickname,
    publisherControlConnected: facts.publisherControlConnected,
    micMediaRecoveryDegraded: freshMicUplink?.transport.mediaRecoveryDegraded === true,
    // Only for the video the room is on: an old error for another video says
    // nothing about this one.
    robotVideoUnplayable: robotPlayerError !== null
      && room.videoId === robotPlayerError.videoId
      && youtubeErrorMeansUnplayable(robotPlayerError.code),
    micAudibilityDegraded: facts.micAudibilityDegraded,
    micInputClipping: freshMicUplink?.captureClipping?.recentDetected === true,
    micLevelWarning: facts.micLevelWarning,
    roomSong: {
      videoId: typeof room.videoId === 'string' && room.videoId ? room.videoId : null,
      connected: Boolean(room.connected),
      clockAgeMs: Number.isFinite(facts.timelineAgeMs) ? facts.timelineAgeMs : Number.POSITIVE_INFINITY,
      state: Number.isFinite(roomState) ? roomState : null,
      handoffState: typeof room.handoffState === 'string' ? room.handoffState : 'idle',
    },
    take: {
      lifecycle: facts.takeStatus.lifecycle,
      takeId: take?.takeId ?? null,
      qualityVerdict: take?.quality?.verdict ?? null,
    },
    timing: {
      timingMode: timing.calibratedMicLagMs === null ? 'network-estimate' : 'acoustic-calibration',
      calibrationState: timing.calibrationState,
      calibrationActive: timing.calibrationActive,
      calibrationStale: timing.calibrationStale,
      alignmentClamped: Math.abs(timing.requestedMicAdvanceMs - timing.appliedMicAdvanceMs) >= 0.5,
      frontierCorrectionActive: timing.micFrontierCorrectionMs >= 0.5,
      // Product timing describes the alignment actually serving the mixer, not a
      // replacement strategy that may be measuring in the background.
      requiresRobotPlayerDelta: timing.robotRouteActive && timing.appliedCalibrationKind === 'boot-probe',
      robotProbeTimingActive: timing.robotProbeTimingActive,
      bootProbeActive: timing.bootProbeActive,
      contentEvidenceReady: timing.contentEvidenceReady,
      robotDeltaFresh: timing.robotDeltaFresh,
    },
  });
}
