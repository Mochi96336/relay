export type ReadinessInput = {
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

export function buildReadiness(input: ReadinessInput) {
  const reasons: ReadinessReason[] = [];
  if (!input.backingConnected) reasons.push('backing-not-connected');
  else {
    if (!input.backingStreaming) reasons.push('backing-not-streaming');
    if (!input.backingIsRobot) reasons.push('backing-not-robot');
  }
  if (!input.robotSourceConnected) reasons.push('robot-source-not-connected');

  const sessionReasons: ReadinessReason[] = [...reasons];
  if (!input.micConnected) sessionReasons.push('mic-not-connected');
  else if (!input.micStreaming) sessionReasons.push('mic-not-streaming');

  if (!input.timelineConnected) sessionReasons.push('phone-timeline-not-connected');
  else if (input.timelineState !== 1) sessionReasons.push('phone-not-playing');
  else if (!input.playerOffsetFresh) sessionReasons.push('robot-player-offset-stale');

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
