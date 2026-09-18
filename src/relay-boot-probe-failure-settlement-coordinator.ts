export type RelayBootProbeFailureDecision = {
  message: string;
} | null;

export type RelayBootProbeFailureSettlementDependencies = {
  restoreCandidateKindToAuthority: () => void;
  failPreservingPrimed: (message: string) => void;
  reportTimingStatus: () => void;
};

/**
 * Owns the cross-domain consequence of BootProbeRuntime's already-made
 * retry/terminal decision.
 *
 * ProbeLifecycle and BootProbeRuntime retain request/retry policy and produce
 * the nullable failure decision. TimingRuntime retains candidate provenance and
 * CalibrationSession retains failure settlement. This seam only preserves the
 * consequence ordering once that probe decision exists.
 */
export function createRelayBootProbeFailureSettlementCoordinator(
  dependencies: RelayBootProbeFailureSettlementDependencies,
) {
  return {
    settle(failure: RelayBootProbeFailureDecision) {
      if (failure) {
        dependencies.restoreCandidateKindToAuthority();
        dependencies.failPreservingPrimed(failure.message);
        return 'terminal' as const;
      }

      dependencies.reportTimingStatus();
      return 'retrying' as const;
    },
  } as const;
}
