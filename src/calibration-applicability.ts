export type CalibrationAuthorityKind = 'none' | 'content' | 'boot-probe';
export type CalibrationApplicability = 'apply' | 'hold' | 'revoke';

export type CalibrationApplicabilityInput = {
  kind: CalibrationAuthorityKind;
  hasResult: boolean;
  stale: boolean;
  calibrationTransactionActive: boolean;
  calibrationProvisional: boolean;
  hasConfirmedResult: boolean;
  robotProbeTimingActive: boolean;
  bootProbeSettled: boolean;
  robotRouteActive: boolean;
  robotSourceConnected: boolean;
  roomHasSong: boolean;
  robotDeltaFresh: boolean;
  robotDeltaEverEstablished: boolean;
  robotContentMappingReady: boolean;
};

/**
 * Decides whether the currently applied calibration authority may
 * drive the live mixer. Runtime sampling and all mutations remain
 * outside this policy.
 *
 * `hold` is deliberately distinct from `revoke`: a quiet Robot
 * heartbeat can leave an already-complete measurement valid even
 * though the live input needed to extend it is temporarily absent.
 */
export function decideCalibrationApplicability(
  input: CalibrationApplicabilityInput,
): CalibrationApplicability {
  if (!input.hasResult || input.stale) return 'revoke';

  const retainingConfirmedAuthority = input.calibrationTransactionActive
    && !input.calibrationProvisional
    && input.hasConfirmedResult;

  if (
    input.robotProbeTimingActive
    && input.kind !== 'boot-probe'
    && !input.bootProbeSettled
    && !retainingConfirmedAuthority
  ) return 'revoke';

  if (input.robotRouteActive && !input.robotSourceConnected) return 'revoke';

  if (
    input.robotRouteActive
    && input.kind === 'boot-probe'
    && input.roomHasSong
    && !input.robotDeltaFresh
  ) return input.robotDeltaEverEstablished ? 'hold' : 'revoke';

  if (
    input.robotRouteActive
    && input.kind === 'content'
    && !input.robotContentMappingReady
  ) return input.robotDeltaEverEstablished ? 'hold' : 'revoke';

  return 'apply';
}
