export type BootProbeStartAuthorityInput = {
  candidateIsBootProbe: boolean;
  hasCalibrationResult: boolean;
  calibrationStale: boolean;
  calibrationTransactionActive: boolean;
};

export type BootProbeStartLifecycleInput = {
  pendingRequest: boolean;
  pendingAnalysis: boolean;
};

export type BootProbeStartTargetInput = {
  probeErrored: boolean;
  calibrationTransactionActive: boolean;
  hasMicLeg: boolean;
  completedContextMatches: boolean;
};

export type BootProbeStartTarget = 'mic' | 'backing';

/**
 * Whether the current candidate/authority state permits a Boot Probe attempt.
 *
 * A fresh settled Boot result is terminal only while no replacement
 * transaction is open. Manual recalibration deliberately retains the old
 * confirmed result while measuring its replacement, so transaction activity
 * must keep the scheduler open even when that retained result is fresh.
 */
export function bootProbeStartAuthorityAllowsAttempt(
  input: BootProbeStartAuthorityInput,
) {
  if (!input.candidateIsBootProbe || !input.hasCalibrationResult) return true;
  if (input.calibrationTransactionActive) return true;
  return input.calibrationStale;
}

/** Pending request/analysis work owns the current lifecycle slot. */
export function bootProbeStartLifecycleIdle(input: BootProbeStartLifecycleInput) {
  return !input.pendingRequest && !input.pendingAnalysis;
}

/**
 * Selects which Boot Probe leg may be attempted after stale-leg reconciliation.
 *
 * Retry cadence, transport readiness and request mutation stay with their
 * runtimes/server. This policy only decides whether there is a logical target.
 */
export function selectBootProbeStartTarget(
  input: BootProbeStartTargetInput,
): BootProbeStartTarget | null {
  if (input.probeErrored) return null;
  if (
    !input.calibrationTransactionActive
    && !input.hasMicLeg
    && input.completedContextMatches
  ) return null;
  return input.hasMicLeg ? 'backing' : 'mic';
}
