export type ReadinessInput = {
  backingConnected: boolean;
  backingStreaming: boolean;
  backingSampleRate: number | null;
  micConnected: boolean;
  micStreaming: boolean;
  robotSourceCount: number;
  sessionActive: boolean;
  timelineConnected: boolean;
  timelineState: number | null;
  playerOffsetMs: number | null;
  playerOffsetFresh: boolean;
  calibrationState: string;
  calibrationValid: boolean;
  calibrationStale: boolean;
  probeCorrelation: { mic: number | null; backing: number | null };
  bootCalibration: unknown;
};

export function buildReadiness(input: ReadinessInput) {
  const reasons: string[] = [];
  if (!input.backingConnected) reasons.push('backing-not-connected');
  else if (!input.backingStreaming) reasons.push('backing-not-streaming');
  if (input.robotSourceCount < 1) reasons.push('robot-source-not-connected');

  const sessionReasons = [...reasons];
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
      },
      mic: {
        connected: input.micConnected,
        streaming: input.micStreaming,
      },
      robotSource: {
        connected: input.robotSourceCount > 0,
        count: input.robotSourceCount,
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
        probeCorrelation: input.probeCorrelation,
        bootCalibration: input.bootCalibration,
      },
      session: {
        active: input.sessionActive,
      },
    },
  };
}
