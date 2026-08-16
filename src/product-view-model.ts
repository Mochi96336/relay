import type { ReadinessSnapshot } from './readiness.js';
import type { TakeQualityVerdict } from './take-quality.js';
import type { TakeLifecycle } from './take-session.js';

export type ProductLifecycle = 'idle' | 'preparing' | 'ready' | 'live' | 'recording';
export type ProductHealth = 'healthy' | 'degraded' | 'blocked';

export type ProductAttentionCode =
  | 'audio-unavailable'
  | 'robot-audio-unavailable'
  | 'robot-route-invalid'
  | 'robot-player-unavailable'
  | 'song-clock-unavailable'
  | 'mic-reconnecting'
  | 'mic-audio-stalled'
  | 'timing-recovering'
  | 'timing-clamped'
  | 'take-failed';

export type ProductAttention = {
  code: ProductAttentionCode;
  scope: 'audio' | 'robot' | 'song' | 'mic' | 'timing' | 'take';
  severity: 'warning' | 'critical';
};

export type ProductRoomSongInput = {
  videoId: string | null;
  connected: boolean;
  state: number | null;
  handoffState: string;
};

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
  roomSong: ProductRoomSongInput;
  take: ProductTakeInput;
  timing: {
    timingMode: 'network-estimate' | 'acoustic-calibration';
    calibrationState: string;
    calibrationStale: boolean;
    alignmentClamped: boolean;
    /**
     * Whether the active timing strategy needs a fresh Robot player delta to
     * make an acoustic calibration applicable. Route identity remains in
     * `readiness.components.route.mode`.
     */
    requiresRobotPlayerDelta: boolean;
    robotDeltaFresh: boolean;
  };
};

export type ProductStatus = {
  type: 'product-status';
  lifecycle: ProductLifecycle;
  health: ProductHealth;
  attention: ProductAttention | null;
  room: {
    participantCount: number;
    mic: {
      state: 'free' | 'starting' | 'live' | 'interrupted' | 'reconnecting';
      ownerId: string | null;
      ownerNickname: string | null;
    };
    song: {
      state: 'empty' | 'ready' | 'playing' | 'handoff' | 'unavailable';
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
    canStopTake: boolean;
  };
};

function productLifecycle(input: ProductViewModelInput): ProductLifecycle {
  if (input.take.lifecycle === 'recording' || input.take.lifecycle === 'finalizing') {
    return 'recording';
  }
  const songLoaded = input.roomSong.videoId !== null;
  if (
    input.roomSong.handoffState !== 'idle'
    || (songLoaded && input.timing.calibrationState === 'collecting')
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

function micState(input: ProductViewModelInput): ProductStatus['room']['mic']['state'] {
  if (input.micOwnerId === null) return 'free';
  const mic = input.readiness.components.mic;
  if (!mic.connected) return 'reconnecting';
  if (!mic.flowObserved) return 'starting';
  if (mic.streaming) return 'live';
  return 'interrupted';
}

function songState(input: ProductViewModelInput): ProductStatus['room']['song']['state'] {
  if (input.roomSong.videoId === null) return 'empty';
  if (input.roomSong.handoffState !== 'idle') return 'handoff';
  if (!input.roomSong.connected) return 'unavailable';
  if (input.roomSong.state === 1) return 'playing';
  return 'ready';
}

function timingState(
  input: ProductViewModelInput,
  lifecycle: ProductLifecycle,
): ProductStatus['timing']['state'] {
  const songLoaded = input.roomSong.videoId !== null;
  if (!songLoaded) return 'idle';
  if (input.timing.calibrationState === 'collecting') return 'calibrating';
  const performanceActive = input.roomSong.state === 1
    && (lifecycle === 'live' || lifecycle === 'recording');
  if (!performanceActive) return 'idle';
  if (input.timing.alignmentClamped) return 'clamped';
  if (input.timing.calibrationStale) return 'stale';
  if (
    input.timing.timingMode === 'acoustic-calibration'
    && input.readiness.components.calibration.valid
    && (!input.timing.requiresRobotPlayerDelta || input.timing.robotDeltaFresh)
  ) return 'aligned';
  return 'fallback';
}

function hostAttention(input: ProductViewModelInput): ProductAttention | null {
  const reasons = new Set(input.readiness.reasons);
  if (reasons.has('backing-not-connected') || reasons.has('backing-not-streaming')) {
    if (input.readiness.components.route.mode === 'robot') {
      return {
        code: 'robot-audio-unavailable',
        scope: 'robot',
        severity: 'critical',
      };
    }
    return {
      code: 'audio-unavailable',
      scope: 'audio',
      severity: 'critical',
    };
  }
  if (reasons.has('backing-not-robot')) {
    return {
      code: 'robot-route-invalid',
      scope: 'robot',
      severity: 'critical',
    };
  }
  if (reasons.has('robot-source-not-connected')) {
    return {
      code: 'robot-player-unavailable',
      scope: 'robot',
      severity: 'critical',
    };
  }
  return null;
}

function productAttention(
  input: ProductViewModelInput,
  lifecycle: ProductLifecycle,
  timing: ProductStatus['timing']['state'],
): ProductAttention | null {
  const host = hostAttention(input);
  if (host) return host;

  const songLoaded = input.roomSong.videoId !== null;
  const performanceActive = lifecycle === 'live' || lifecycle === 'recording';
  if (songLoaded && !input.roomSong.connected) {
    return {
      code: 'song-clock-unavailable',
      scope: 'song',
      severity: performanceActive ? 'critical' : 'warning',
    };
  }

  if (input.micOwnerId !== null && micState(input) === 'interrupted') {
    return {
      code: 'mic-audio-stalled',
      scope: 'mic',
      severity: 'warning',
    };
  }

  if (input.micOwnerId !== null && micState(input) === 'reconnecting') {
    return {
      code: 'mic-reconnecting',
      scope: 'mic',
      severity: 'warning',
    };
  }

  if (input.take.lifecycle === 'failed') {
    return {
      code: 'take-failed',
      scope: 'take',
      severity: 'warning',
    };
  }

  if (performanceActive && timing === 'clamped') {
    return {
      code: 'timing-clamped',
      scope: 'timing',
      severity: 'warning',
    };
  }

  if (performanceActive && ['calibrating', 'fallback', 'stale'].includes(timing)) {
    return {
      code: 'timing-recovering',
      scope: 'timing',
      severity: 'warning',
    };
  }

  return null;
}

/**
 * Converts Relay's transport/readiness state into the small semantic surface a
 * product UI is allowed to depend on.
 *
 * The important distinction is that technical session readiness is not product
 * health. `mic-not-connected`, `phone-not-playing`, and `calibration-missing`
 * are expected while an otherwise healthy room is idle. Host/robot failures
 * remain real health failures in every lifecycle, while Mic/timing failures are
 * surfaced only when that subsystem is actually in use.
 */
export function buildProductViewModel(input: ProductViewModelInput): ProductStatus {
  const lifecycle = productLifecycle(input);
  const timing = timingState(input, lifecycle);
  const attention = productAttention(input, lifecycle, timing);
  const health: ProductHealth = attention?.severity === 'critical'
    ? 'blocked'
    : attention
      ? 'degraded'
      : 'healthy';

  return {
    type: 'product-status',
    lifecycle,
    health,
    attention,
    room: {
      participantCount: input.participantCount,
      mic: {
        state: micState(input),
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
      canStartTake: input.readiness.components.session.active
        && (
          input.roomSong.videoId === null
            ? micState(input) === 'live'
            : health !== 'blocked'
        )
        && input.take.lifecycle !== 'recording'
        && input.take.lifecycle !== 'finalizing',
      canStopTake: input.take.lifecycle === 'recording',
    },
  };
}
