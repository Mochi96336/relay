import type { RoomMicState } from './room-domain.js';
import type { TakeLifecycle } from './take-session.js';

export type ProductIssueCode =
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

/** Compatibility name for consumers that still render only the highest-priority issue. */
export type ProductAttentionCode = ProductIssueCode;

export type ProductIssueCause =
  | 'backing-not-ready'
  | 'backing-unavailable'
  | 'backing-stalled'
  | 'backing-route-mismatch'
  | 'robot-source-unavailable'
  | 'song-clock-lost'
  | 'mic-transport-disconnected'
  | 'mic-audio-stalled'
  | 'timing-calibrating'
  | 'timing-fallback'
  | 'timing-stale'
  | 'timing-clamped'
  | 'recording-failed';

export type ProductImpact = 'song' | 'voice' | 'recording' | 'timing';

export type ProductRecovery =
  | 'automatic'
  | 'retry-mic'
  | 'retry-recording'
  | 'recalibrate'
  | 'host-service';

export type ProductIssue = {
  code: ProductIssueCode;
  scope: 'audio' | 'robot' | 'song' | 'mic' | 'timing' | 'take';
  severity: 'warning' | 'critical';
  cause: ProductIssueCause;
  affects: ProductImpact[];
  recovery: ProductRecovery;
};

/**
 * Legacy compatibility surface. Keep this exact three-field shape while richer
 * product UI moves to `issues[]`.
 */
export type ProductAttention = {
  code: ProductAttentionCode;
  scope: ProductIssue['scope'];
  severity: ProductIssue['severity'];
};

export type ProductIssueFacts = {
  routeMode: 'idle' | 'song' | 'legacy' | 'robot';
  backing: {
    connected: boolean;
    streaming: boolean;
    robot: boolean;
  };
  robotSourceConnected: boolean;
  songClockSeverity: 'warning' | 'critical' | null;
  mic: {
    ownerId: string | null;
    state: RoomMicState;
  };
  takeLifecycle: TakeLifecycle;
  performanceActive: boolean;
  timingState: 'idle' | 'calibrating' | 'aligned' | 'fallback' | 'stale' | 'clamped';
};

function hostIssues(facts: ProductIssueFacts) {
  const issues: ProductIssue[] = [];
  if (facts.routeMode === 'idle') return issues;

  if (!facts.backing.connected) {
    const waitingForRoute = facts.routeMode === 'song'
      || (
        facts.routeMode === 'robot'
        && facts.robotSourceConnected
        && !facts.backing.robot
      );
    issues.push({
      code: facts.routeMode === 'robot' ? 'robot-audio-unavailable' : 'audio-unavailable',
      scope: facts.routeMode === 'robot' ? 'robot' : 'audio',
      severity: 'critical',
      // `song` has no concrete backing route yet. Likewise a Robot source can
      // arm the route before its first Robot backing socket registers. In both
      // cases a false `connected` bit means "not ready", not "disconnected".
      // Once Robot identity (or legacy grace) has been established, absence is
      // an actual unavailable route instead of normal startup.
      cause: waitingForRoute ? 'backing-not-ready' : 'backing-unavailable',
      affects: ['song', 'recording'],
      recovery: waitingForRoute ? 'automatic' : 'host-service',
    });
  } else if (!facts.backing.streaming) {
    issues.push({
      code: facts.routeMode === 'robot' ? 'robot-audio-unavailable' : 'audio-unavailable',
      scope: facts.routeMode === 'robot' ? 'robot' : 'audio',
      severity: 'critical',
      cause: 'backing-stalled',
      affects: ['song', 'recording'],
      recovery: 'automatic',
    });
  }

  if (facts.routeMode === 'robot' && facts.backing.connected && !facts.backing.robot) {
    issues.push({
      code: 'robot-route-invalid',
      scope: 'robot',
      severity: 'critical',
      cause: 'backing-route-mismatch',
      affects: ['song', 'recording'],
      recovery: 'host-service',
    });
  }

  if (facts.routeMode === 'robot' && !facts.robotSourceConnected) {
    issues.push({
      code: 'robot-player-unavailable',
      scope: 'robot',
      severity: 'critical',
      // Availability is observable; whether it ever connected is not.
      cause: 'robot-source-unavailable',
      affects: ['song', 'recording'],
      recovery: 'host-service',
    });
  }

  return issues;
}

/**
 * Converts already-derived product facts into issues a normal UI can explain
 * without reading readiness snapshots or diagnostics evidence.
 *
 * Ordering is intentional: infrastructure/room continuity first, then song,
 * Mic, recording and finally timing. Legacy `attention` consumers receive a
 * three-field projection of the first issue while richer surfaces render all
 * issues directly.
 */
export function buildProductIssues(facts: ProductIssueFacts): ProductIssue[] {
  const issues = hostIssues(facts);

  if (facts.songClockSeverity) {
    issues.push({
      code: 'song-clock-unavailable',
      scope: 'song',
      severity: facts.songClockSeverity,
      cause: 'song-clock-lost',
      affects: ['song', 'timing'],
      recovery: 'automatic',
    });
  }

  if (facts.mic.ownerId !== null && facts.mic.state === 'interrupted') {
    issues.push({
      code: 'mic-audio-stalled',
      scope: 'mic',
      severity: 'warning',
      cause: 'mic-audio-stalled',
      affects: ['voice', 'recording'],
      recovery: 'retry-mic',
    });
  } else if (facts.mic.ownerId !== null && facts.mic.state === 'reconnecting') {
    issues.push({
      code: 'mic-reconnecting',
      scope: 'mic',
      severity: 'warning',
      cause: 'mic-transport-disconnected',
      affects: ['voice', 'recording'],
      recovery: 'automatic',
    });
  }

  if (facts.takeLifecycle === 'failed') {
    issues.push({
      code: 'take-failed',
      scope: 'take',
      severity: 'warning',
      cause: 'recording-failed',
      affects: ['recording'],
      recovery: 'retry-recording',
    });
  }

  if (facts.performanceActive && facts.timingState === 'clamped') {
    issues.push({
      code: 'timing-clamped',
      scope: 'timing',
      severity: 'warning',
      cause: 'timing-clamped',
      affects: ['timing', 'recording'],
      recovery: 'recalibrate',
    });
  } else if (facts.performanceActive && ['calibrating', 'fallback', 'stale'].includes(facts.timingState)) {
    const cause = facts.timingState === 'calibrating'
      ? 'timing-calibrating'
      : facts.timingState === 'stale'
        ? 'timing-stale'
        : 'timing-fallback';
    issues.push({
      code: 'timing-recovering',
      scope: 'timing',
      severity: 'warning',
      cause,
      affects: ['timing', 'recording'],
      recovery: facts.timingState === 'calibrating' ? 'automatic' : 'recalibrate',
    });
  }

  return issues;
}
