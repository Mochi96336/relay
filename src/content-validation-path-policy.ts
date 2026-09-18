import type { TimingCalibrationKind } from './timing-runtime.js';

export type ContentValidationPathPrerequisiteInput = {
  enabled: boolean;
  takeBlocked: boolean;
  bootProbeSettled: boolean;
  robotRouteActive: boolean;
  robotEvidenceMappingReady: boolean;
  sessionActive: boolean;
  calibrationCollecting: boolean;
};

export type ContentValidationAuthorityInput = {
  appliedKind: TimingCalibrationKind;
  hasConfirmedResult: boolean;
  calibrationStale: boolean;
};

export type ContentValidationLivePathInput = {
  backingConnected: boolean;
  micControlConnected: boolean;
  streamsFlowing: boolean;
  timelineConnected: boolean;
  timelinePlaying: boolean;
};

/**
 * Early admission facts that do not need applied-authority or live-transport
 * sampling. Keeping this phase explicit preserves the server's cheap
 * prerequisite short-circuit without making authority reads stateful.
 */
export function contentValidationPathPrerequisitesReady(
  input: ContentValidationPathPrerequisiteInput,
) {
  if (!input.enabled || input.takeBlocked) return false;
  if (!input.bootProbeSettled) return false;
  if (input.robotRouteActive && !input.robotEvidenceMappingReady) return false;
  return input.sessionActive && !input.calibrationCollecting;
}

/** Applied provenance gate. Candidate strategy must never substitute here. */
export function contentValidationAuthorityReady(
  input: ContentValidationAuthorityInput,
) {
  return input.appliedKind === 'content'
    && input.hasConfirmedResult
    && !input.calibrationStale;
}

/** Final transport/media liveness gate after authority has been admitted. */
export function contentValidationLivePathReady(
  input: ContentValidationLivePathInput,
) {
  return input.backingConnected
    && input.micControlConnected
    && input.streamsFlowing
    && input.timelineConnected
    && input.timelinePlaying;
}
