export type RouteMode = 'idle' | 'legacy' | 'robot';

export type ReadinessInput = {
  /**
   * Which backing route the host is expected to provide right now.
   *
   * `idle` means no route has been armed, so missing Robot infrastructure is
   * state rather than failure. `legacy` requires only a live backing stream.
   * `robot` requires the formal Robot backing identity plus its source page.
   *
   * Runtime callers should pass this explicitly when they retain route intent
   * across reconnect grace. Older callers can omit it and the pure model will
   * infer the current route from observable facts.
   */
  routeMode?: RouteMode;
  backingConnected: boolean;
  backingStreaming: boolean;
  backingSampleRate: number | null;
  backingIsRobot: boolean;
  micConnected: boolean;
  micStreaming: boolean;
  robotSourceConnected: boolean;
  sessionActive: boolean;
  timelineConnected: boolean;
  timelineState: number | null;
  playerOffsetMs: number | null;
  playerOffsetFresh: boolean;
  calibrationState: string;
  calibrationValid: boolean;
  calibrationStale: boolean;
  calibrationKind?: string;
  probeCorrelation: { mic: number | null; backing: number | null };
  bootCalibration: unknown;
};

export type ReadinessReason =
  | 'backing-not-connected'
  | 'backing-not-streaming'
  | 'backing-not-robot'
  | 'robot-source-not-connected'
  | 'mic-not-connected'
  | 'mic-not-streaming'
  | 'phone-timeline-not-connected'
  | 'phone-not-playing'
  | 'robot-player-offset-stale'
  | 'calibration-collecting'
  | 'calibration-stale'
  | 'calibration-missing';

function inferRouteMode(input: ReadinessInput): RouteMode {
  if (input.backingIsRobot || input.robotSourceConnected || input.calibrationKind === 'boot-probe') {
    return 'robot';
  }
  if (input.backingConnected || input.sessionActive) return 'legacy';
  return 'idle';
}

export function buildReadiness(input: ReadinessInput) {
  const routeMode = input.routeMode ?? inferRouteMode(input);
  const reasons: ReadinessReason[] = [];

  if (routeMode !== 'idle') {
    if (!input.backingConnected) reasons.push('backing-not-connected');
    else {
      if (!input.backingStreaming) reasons.push('backing-not-streaming');
      if (routeMode === 'robot' && !input.backingIsRobot) reasons.push('backing-not-robot');
    }
    if (routeMode === 'robot' && !input.robotSourceConnected) {
      reasons.push('robot-source-not-connected');
    }
  }

  const sessionReasons: ReadinessReason[] = [...reasons];
  if (input.sessionActive && routeMode === 'idle') {
    // A live mixer without a backing route is a degraded transition (for
    // example the backing grace window), not a legitimately idle host.
    sessionReasons.push('backing-not-connected');
  }

  if (!input.micConnected) sessionReasons.push('mic-not-connected');
  else if (!input.micStreaming) sessionReasons.push('mic-not-streaming');

  if (!input.timelineConnected) sessionReasons.push('phone-timeline-not-connected');
  else if (input.timelineState !== 1) sessionReasons.push('phone-not-playing');
  else if (routeMode === 'robot' && !input.playerOffsetFresh) {
    sessionReasons.push('robot-player-offset-stale');
  }

  if (!input.calibrationValid) {
    if (input.calibrationState === 'collecting') sessionReasons.push('calibration-collecting');
    else if (input.calibrationStale) sessionReasons.push('calibration-stale');
    else sessionReasons.push('calibration-missing');
  }

  const ready = reasons.length === 0;
  return {
    ok: ready,
    ready,
    sessionReady: sessionReasons.length === 0,
    reasons,
    sessionReasons,
    components: {
      route: {
        mode: routeMode,
      },
      backing: {
        connected: input.backingConnected,
        streaming: input.backingStreaming,
        sampleRate: input.backingSampleRate,
        robot: input.backingIsRobot,
      },
      mic: {
        connected: input.micConnected,
        streaming: input.micStreaming,
      },
      robotSource: {
        connected: input.robotSourceConnected,
      },
      player: {
        timelineConnected: input.timelineConnected,
        state: input.timelineState,
        offsetMs: input.playerOffsetFresh ? input.playerOffsetMs : null,
        offsetFresh: input.playerOffsetFresh,
      },
      calibration: {
        state: input.calibrationState,
        valid: input.calibrationValid,
        stale: input.calibrationStale,
        kind: input.calibrationKind ?? null,
        probeCorrelation: input.probeCorrelation,
        bootCalibration: input.bootCalibration,
      },
      session: {
        active: input.sessionActive,
      },
    },
  };
}

export type ReadinessSnapshot = ReturnType<typeof buildReadiness>;
