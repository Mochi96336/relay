export type BootProbeCalibrationApplicability = 'apply' | 'hold' | 'revoke';

export type BootProbeMixerApplicationInput = {
  activeMicLagMs: number | null;
  roomHasSong: boolean;
  resultMicLagMs: number | null;
  pathDifferenceMs: number | null;
  calibrationStale: boolean;
  completedContextMatches: boolean;
  applicability: BootProbeCalibrationApplicability;
  storedDeltaMs: number | null;
  currentDeltaMs: number;
};

export type BootProbeMixerApplicationDecision =
  | { kind: 'hold' }
  | { kind: 'set'; micLagMs: number | null };

const STORED_DELTA_MATCH_EPSILON_MS = 0.001;

/**
 * Decides how an already-confirmed Boot Probe result may drive the live mixer.
 *
 * This policy is intentionally pure. Runtime freshness, route topology,
 * calibration provenance, and player-offset sampling remain server/runtime
 * authorities; AudioSession remains the effect owner that actually writes the
 * chosen lag. The decision here only preserves the ordering and fallback rules
 * that used to be embedded in `syncAppliedCalibration()`.
 */
export function decideBootProbeMixerApplication(
  input: BootProbeMixerApplicationInput,
): BootProbeMixerApplicationDecision {
  if (
    !input.roomHasSong
    && input.resultMicLagMs !== null
    && input.pathDifferenceMs !== null
    && !input.calibrationStale
    && input.completedContextMatches
  ) {
    return input.activeMicLagMs === input.pathDifferenceMs
      ? { kind: 'hold' }
      : { kind: 'set', micLagMs: input.pathDifferenceMs };
  }

  if (input.applicability === 'hold') return { kind: 'hold' };

  if (input.applicability === 'revoke') {
    return input.activeMicLagMs === null
      ? { kind: 'hold' }
      : { kind: 'set', micLagMs: null };
  }

  // A Boot Probe total without the player delta it was recorded against cannot
  // be compared safely with the current player-relative term. Fail closed rather
  // than letting a provenance-less total become live authority.
  if (input.storedDeltaMs === null) {
    return input.activeMicLagMs === null
      ? { kind: 'hold' }
      : { kind: 'set', micLagMs: null };
  }

  // A fresh delta moving away from the stored one does not itself invalidate the
  // acoustic measurement. Hold the current total until the explicit reapply path
  // decides whether the smoothed movement crosses its threshold.
  if (Math.abs(input.storedDeltaMs - input.currentDeltaMs) >= STORED_DELTA_MATCH_EPSILON_MS) {
    return { kind: 'hold' };
  }

  if (input.activeMicLagMs !== null) {
    if (
      input.resultMicLagMs !== null
      && input.activeMicLagMs !== input.resultMicLagMs
    ) {
      return { kind: 'set', micLagMs: input.resultMicLagMs };
    }
    return { kind: 'hold' };
  }

  return input.resultMicLagMs === null
    ? { kind: 'hold' }
    : { kind: 'set', micLagMs: input.resultMicLagMs };
}
