import type { ReadinessSnapshot } from './readiness.js';
import {
  deriveRoomMicState,
  deriveRoomSongState,
  roomSongClockSeverity,
  type RoomMicState,
  type RoomSongFacts,
  type RoomSongState,
} from './room-domain.js';
import {
  buildProductIssues,
  type ProductAttention,
  type ProductIssue,
} from './product-issues.js';
import type { TakeQualityVerdict } from './take-quality.js';
import type { TakeLifecycle } from './take-session.js';
import { decideTakeStart, type TakeStartBlockReason } from './take-start-policy.js';
import {
  decideCalibrationStart,
  type CalibrationStartBlockReason,
  type CalibrationStartMode,
} from './calibration-start-policy.js';

export type {
  ProductAttention,
  ProductAttentionCode,
  ProductImpact,
  ProductIssue,
  ProductIssueCause,
  ProductIssueCode,
  ProductRecovery,
} from './product-issues.js';

export type ProductLifecycle = 'idle' | 'preparing' | 'ready' | 'live' | 'recording';
export type ProductHealth = 'healthy' | 'degraded' | 'blocked';

export type ProductRoomSongInput = RoomSongFacts;

export type ProductTakeInput = {
  lifecycle: TakeLifecycle;
  takeId: string | null;
  qualityVerdict: TakeQualityVerdict | null;
};

export type ProductViewModelInput = {
  readiness: ReadinessSnapshot;
  participantCount: number;
  micOwnerId: string | null;
  micOwnerNickname: string | null;
  /** Manual calibration needs the publisher control socket, not only Mic media. */
  publisherControlConnected?: boolean;
  roomSong: ProductRoomSongInput;
  take: ProductTakeInput;
  timing: {
    timingMode: 'network-estimate' | 'acoustic-calibration';
    calibrationState: string;
    /** Explicitly includes boot-probe activity that CalibrationSession alone cannot represent. */
    calibrationActive?: boolean;
    calibrationStale: boolean;
    alignmentClamped: boolean;
    /**
     * Whether the active timing strategy needs a fresh Robot player delta to
     * make an acoustic calibration applicable. Route identity remains in
     * `readiness.components.route.mode`.
     */
    requiresRobotPlayerDelta: boolean;
    /** Whether manual calibration should use the Robot boot-probe path. */
    robotProbeTimingActive?: boolean;
    /**
     * Whether the measurement in flight is the audible boot probe.
     *
     * `robotProbeTimingActive` is which strategy a *new* run would use;
     * this is what the run happening now actually is. Only the probe occupies
     * the room, so only the probe is a preparation stage.
     */
    bootProbeActive?: boolean;
    /** Whether a content-mode calibration can accept Robot backing evidence now. */
    contentEvidenceReady?: boolean;
    robotDeltaFresh: boolean;
  };
};

export type ProductStatus = {
  type: 'product-status';
  lifecycle: ProductLifecycle;
  health: ProductHealth;
  /** Ordered product-semantic issues. Normal UI must not need diagnostics to explain them. */
  issues: ProductIssue[];
  /** Exact legacy compatibility shape: the highest-priority issue projected to three fields. */
  attention: ProductAttention | null;
  room: {
    participantCount: number;
    mic: {
      state: RoomMicState;
      ownerId: string | null;
      ownerNickname: string | null;
    };
    song: {
      state: RoomSongState;
      videoId: string | null;
      handoffState: string;
    };
  };
  timing: {
    state: 'idle' | 'calibrating' | 'aligned' | 'fallback' | 'stale' | 'clamped';
  };
  take: {
    lifecycle: TakeLifecycle;
    takeId: string | null;
    verdict: TakeQualityVerdict | null;
  };
  actions: {
    canStartTake: boolean;
    startTakeBlockedReason: TakeStartBlockReason | null;
    /** Concrete product issue that makes a Song Take's room-level block actionable to normal UI. */
    startTakeBlockingIssue: ProductIssue | null;
    canStopTake: boolean;
    canStartCalibration: boolean;
    startCalibrationBlockedReason: CalibrationStartBlockReason | null;
    /** Candidate mode is projected even while blocked so UI never guesses prerequisites from Song state. */
    startCalibrationMode: CalibrationStartMode | null;
  };
};

function calibrationActive(input: ProductViewModelInput) {
  return input.timing.calibrationActive === true
    || input.timing.calibrationState === 'collecting';
}

/**
 * The half of calibration that is a stage the room waits in.
 *
 * The boot probe plays its own chimes through the phone and the Robot output
 * and needs both captures to itself, so while it runs the room really is
 * getting ready. Content calibration only listens to audio the room is already
 * making: it changes nothing the singer hears, so presenting the room as
 * preparing - or refusing a Take - would describe a measurement, not the room.
 */
function preparingCalibrationActive(input: ProductViewModelInput) {
  return calibrationActive(input) && input.timing.bootProbeActive === true;
}

/** Whether an acoustic measurement is the alignment the mixer is actually serving. */
function acousticAlignmentServing(input: ProductViewModelInput) {
  return input.timing.timingMode === 'acoustic-calibration'
    && input.readiness.components.calibration.valid
    && (!input.timing.requiresRobotPlayerDelta || input.timing.robotDeltaFresh);
}

function micState(input: ProductViewModelInput): RoomMicState {
  const mic = input.readiness.components.mic;
  return deriveRoomMicState({
    ownerId: input.micOwnerId,
    connected: mic.connected,
    flowObserved: mic.flowObserved,
    startupTimedOut: mic.startupTimedOut,
    streaming: mic.streaming,
  });
}

function productLifecycle(input: ProductViewModelInput): ProductLifecycle {
  if (input.take.lifecycle === 'recording' || input.take.lifecycle === 'finalizing') {
    return 'recording';
  }
  const songLoaded = input.roomSong.videoId !== null;
  if (
    input.roomSong.handoffState !== 'idle'
    || (songLoaded && preparingCalibrationActive(input))
  ) {
    return 'preparing';
  }

  const mic = micState(input);
  if (!songLoaded && mic === 'starting') return 'preparing';
  if (songLoaded) {
    if (input.roomSong.state === 1 && input.readiness.components.session.active) return 'live';
    return 'ready';
  }
  if (
    input.readiness.components.session.active
    && (mic === 'live' || mic === 'interrupted' || mic === 'reconnecting')
  ) return 'live';
  return 'idle';
}

function songState(input: ProductViewModelInput): RoomSongState {
  return deriveRoomSongState(input.roomSong);
}

function timingState(
  input: ProductViewModelInput,
  lifecycle: ProductLifecycle,
): ProductStatus['timing']['state'] {
  const songLoaded = input.roomSong.videoId !== null;
  if (!songLoaded) return 'idle';
  if (preparingCalibrationActive(input)) return 'calibrating';
  const performanceActive = input.roomSong.state === 1
    && (lifecycle === 'live' || lifecycle === 'recording');
  if (!performanceActive) return calibrationActive(input) ? 'calibrating' : 'idle';
  if (input.timing.alignmentClamped) return 'clamped';
  // Applied authority, not the candidate being measured. A background content
  // run deliberately leaves the previous confirmed result serving, so reading
  // the run here would report a room whose alignment is live and correct as
  // one that is still getting ready.
  if (acousticAlignmentServing(input) && !input.timing.calibrationStale) return 'aligned';
  // Nothing trustworthy is serving. A measurement already in flight *is* the
  // recovery, so say that rather than asking for a recalibration that is
  // already running.
  if (calibrationActive(input)) return 'calibrating';
  if (input.timing.calibrationStale) return 'stale';
  return 'fallback';
}

function primaryAttention(issues: ProductIssue[]): ProductAttention | null {
  const issue = issues[0];
  if (!issue) return null;
  return {
    code: issue.code,
    scope: issue.scope,
    severity: issue.severity,
  };
}

/**
 * Converts Relay's transport/readiness state into the small semantic surface a
 * product UI is allowed to depend on.
 *
 * The important distinction is that technical session readiness is not product
 * health. `mic-not-connected`, `phone-not-playing`, and `calibration-missing`
 * are expected while an otherwise healthy room is idle. Product issues are
 * derived from semantic component facts and carry their own cause/impact/
 * recovery contract, so normal UI never has to inspect readiness or diagnostics
 * to explain what is wrong.
 */
export function buildProductViewModel(input: ProductViewModelInput): ProductStatus {
  const lifecycle = productLifecycle(input);
  const timing = timingState(input, lifecycle);
  const mic = micState(input);
  const performanceActive = lifecycle === 'live' || lifecycle === 'recording';
  const issues = buildProductIssues({
    routeMode: input.readiness.components.route.mode,
    backing: {
      connected: input.readiness.components.backing.connected,
      streaming: input.readiness.components.backing.streaming,
      robot: input.readiness.components.backing.robot,
    },
    robotSourceConnected: input.readiness.components.robotSource.connected,
    songClockSeverity: roomSongClockSeverity(input.roomSong, performanceActive),
    mic: {
      ownerId: input.micOwnerId,
      state: mic,
    },
    takeLifecycle: input.take.lifecycle,
    performanceActive,
    timingState: timing,
  });
  const attention = primaryAttention(issues);
  const health: ProductHealth = issues.some((issue) => issue.severity === 'critical')
    ? 'blocked'
    : issues.length > 0
      ? 'degraded'
      : 'healthy';

  const startTake = decideTakeStart({
    sessionActive: input.readiness.components.session.active,
    bootProbeCalibrationActive: preparingCalibrationActive(input),
    songLoaded: input.roomSong.videoId !== null,
    voiceOnlyMicState: mic,
    roomBlocked: health === 'blocked',
    takeLifecycle: input.take.lifecycle,
  });
  const startTakeBlockingIssue = !startTake.ok && startTake.reason === 'room-blocked'
    ? issues.find((issue) => issue.severity === 'critical') ?? null
    : null;
  const startCalibration = decideCalibrationStart({
    takeLifecycle: input.take.lifecycle,
    calibrationActive: calibrationActive(input),
    sessionActive: input.readiness.components.session.active,
    backingConnected: input.readiness.components.backing.connected,
    publisherControlConnected: input.publisherControlConnected === true,
    backingStreaming: input.readiness.components.backing.streaming,
    micStreaming: input.readiness.components.mic.streaming,
    robotProbeTimingActive: input.timing.robotProbeTimingActive === true,
    contentEvidenceReady: input.timing.contentEvidenceReady,
    backingIsRobot: input.readiness.components.backing.robot,
    robotSourceConnected: input.readiness.components.robotSource.connected,
    timelineConnected: input.readiness.components.player.timelineConnected,
    timelineState: input.readiness.components.player.state,
  });

  return {
    type: 'product-status',
    lifecycle,
    health,
    issues,
    attention,
    room: {
      participantCount: input.participantCount,
      mic: {
        state: mic,
        ownerId: input.micOwnerId,
        ownerNickname: input.micOwnerNickname,
      },
      song: {
        state: songState(input),
        videoId: input.roomSong.videoId,
        handoffState: input.roomSong.handoffState,
      },
    },
    timing: { state: timing },
    take: {
      lifecycle: input.take.lifecycle,
      takeId: input.take.takeId,
      verdict: input.take.qualityVerdict,
    },
    actions: {
      canStartTake: startTake.ok,
      startTakeBlockedReason: startTake.ok ? null : startTake.reason,
      startTakeBlockingIssue,
      canStopTake: input.take.lifecycle === 'recording',
      canStartCalibration: startCalibration.ok,
      startCalibrationBlockedReason: startCalibration.ok ? null : startCalibration.reason,
      startCalibrationMode: startCalibration.mode,
    },
  };
}
