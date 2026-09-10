import type { TimingCalibrationKind } from './timing-runtime.js';

export type AutoContentCalibrationPrerequisiteInput = {
  bootProbeSettled: boolean;
  robotRouteActive: boolean;
  robotEvidenceMappingReady: boolean;
  sessionActive: boolean;
  calibrationCollecting: boolean;
};

export type AutoContentCalibrationAuthorityInput = {
  freshConfirmedResult: boolean;
  robotRouteActive: boolean;
  appliedKind: TimingCalibrationKind | null;
};

export type AutoContentCalibrationLivePathInput = {
  retryDue: boolean;
  backingConnected: boolean;
  micControlConnected: boolean;
  streamsFlowing: boolean;
  timelineConnected: boolean;
  timelinePlaying: boolean;
};

export type AutoContentCalibrationStartMode = 'fresh' | 'primed';

/** Calibration-specific prerequisites after the outer feature/Take guard. */
export function autoContentCalibrationPrerequisitesReady(
  input: AutoContentCalibrationPrerequisiteInput,
) {
  if (!input.bootProbeSettled) return false;
  if (input.robotRouteActive && !input.robotEvidenceMappingReady) return false;
  return input.sessionActive && !input.calibrationCollecting;
}

/**
 * Whether existing confirmed authority permits an automatic content attempt.
 *
 * A fresh non-Robot result is terminal. On a Robot route, a fresh boot result
 * is intentionally replaceable by content authority, while fresh content is
 * already the desired terminal strategy. `appliedKind` is nullable so callers
 * can avoid the stateful applied-authority read unless fresh Robot authority
 * actually requires it; null in that required state fails closed.
 */
export function autoContentCalibrationAuthorityAllowsStart(
  input: AutoContentCalibrationAuthorityInput,
) {
  if (!input.freshConfirmedResult) return true;
  if (!input.robotRouteActive) return false;
  return input.appliedKind !== null && input.appliedKind !== 'content';
}

/** Final retry/transport/media admission after authority has been admitted. */
export function autoContentCalibrationLivePathReady(
  input: AutoContentCalibrationLivePathInput,
) {
  return input.retryDue
    && input.backingConnected
    && input.micControlConnected
    && input.streamsFlowing
    && input.timelineConnected
    && input.timelinePlaying;
}

/** A bounded failed Boot run may hand its already-primed evidence to content. */
export function autoContentCalibrationStartMode(
  probeCalibrationExhausted: boolean,
): AutoContentCalibrationStartMode {
  return probeCalibrationExhausted ? 'primed' : 'fresh';
}
