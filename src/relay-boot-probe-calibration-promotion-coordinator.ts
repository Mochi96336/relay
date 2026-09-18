export type RelayBootProbeCalibrationPromotionResult = {
  micLagMs: number;
  confidence: number;
};

export type RelayBootProbeCalibrationPromotionDependencies = {
  markBootProbeAuthority: () => void;
  applyExternalResult: (result: RelayBootProbeCalibrationPromotionResult) => void;
};

/**
 * Preserves the synchronous promotion ordering for a completed Boot Probe.
 *
 * BootProbeRuntime retains probe state/evidence authority, TimingRuntime retains
 * calibration-kind authority, and CalibrationSession retains result application.
 * This seam owns only the ordering between those server-owned effects. The
 * result remains lazy because some callers read probe state produced by the
 * mutation itself.
 */
export function createRelayBootProbeCalibrationPromotionCoordinator(
  dependencies: RelayBootProbeCalibrationPromotionDependencies,
) {
  return {
    promote(
      mutateProbe: () => void,
      result: () => RelayBootProbeCalibrationPromotionResult,
    ) {
      mutateProbe();
      dependencies.markBootProbeAuthority();
      dependencies.applyExternalResult(result());
    },
  } as const;
}
