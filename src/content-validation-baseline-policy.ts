import type { TimingCalibrationKind } from './timing-runtime.js';

export type ContentValidationBaselineSyncInput = {
  appliedKind: TimingCalibrationKind;
  hasConfirmedResult: boolean;
  calibrationStale: boolean;
  hasBaseline: boolean;
  baselineRevision: number;
  confirmedRevision: number;
};

export type ContentValidationBaselineSyncDecision = 'none' | 'clear' | 'set';

/**
 * Decides whether the content-drift validator should keep, clear, or reseed its
 * baseline. The caller owns every runtime read and every mutation; this policy
 * owns only provenance/revision applicability.
 */
export function decideContentValidationBaselineSync(
  input: ContentValidationBaselineSyncInput,
): ContentValidationBaselineSyncDecision {
  const applicableContentAuthority = input.appliedKind === 'content'
    && input.hasConfirmedResult
    && !input.calibrationStale;

  if (!applicableContentAuthority) return input.hasBaseline ? 'clear' : 'none';
  if (input.hasBaseline && input.baselineRevision === input.confirmedRevision) return 'none';
  return 'set';
}
