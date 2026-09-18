export type BootProbeAppliedCalibrationKind = 'none' | 'content' | 'boot-probe';
export type BootProbeReplacementApplicability = 'apply' | 'hold' | 'revoke';
export type BootProbeReapplicationReason = 'delta-moved' | 'reclaim';

export type BootProbeReapplicationInput = {
  appliedKind: BootProbeAppliedCalibrationKind;
  replacementApplicability: BootProbeReplacementApplicability | null;
  roomHasSong: boolean;
  pathDifferenceReady: boolean;
  calibrationCollecting: boolean;
  calibrationTransactionActive: boolean;
  robotDeltaFresh: boolean;
  completedContextMatches: boolean;
  advanceMs: number | null;
  appliedMicLagMs: number | null;
  reapplyThresholdMs: number;
};

export type BootProbeReapplicationDecision =
  | { kind: 'none' }
  | { kind: 'reapply'; reason: BootProbeReapplicationReason; advanceMs: number };

/**
 * Decides whether retained Boot Probe evidence may update or reclaim
 * the live mixer after the caller has entered the Robot reapply path.
 *
 * Runtime sampling and every mutation stay outside this policy. In
 * particular, playback-rate conversion, BootProbeRuntime mutation,
 * calibration promotion, and AudioSession effects remain owned by the
 * server and their existing coordinators.
 */
export function decideBootProbeReapplication(
  input: BootProbeReapplicationInput,
): BootProbeReapplicationDecision {
  const reclaiming = input.appliedKind !== 'boot-probe'
    && input.replacementApplicability === 'revoke';

  if (input.appliedKind !== 'boot-probe' && !reclaiming) return { kind: 'none' };
  if (!input.roomHasSong) return { kind: 'none' };
  if (
    !input.pathDifferenceReady
    || input.calibrationCollecting
    || input.calibrationTransactionActive
  ) return { kind: 'none' };
  if (!input.robotDeltaFresh) return { kind: 'none' };
  if (!input.completedContextMatches) return { kind: 'none' };
  if (input.advanceMs === null) return { kind: 'none' };
  if (
    input.appliedMicLagMs !== null
    && Math.abs(input.advanceMs - input.appliedMicLagMs) < input.reapplyThresholdMs
  ) return { kind: 'none' };

  return {
    kind: 'reapply',
    reason: reclaiming ? 'reclaim' : 'delta-moved',
    advanceMs: input.advanceMs,
  };
}
