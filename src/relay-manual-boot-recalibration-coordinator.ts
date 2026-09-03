export type RelayManualBootRecalibrationDependencies = {
  clearContentValidation: () => void;
  beginExternalRecalibration: () => void;
  beginManualBootProbe: () => void;
  abandonProbeRun: () => void;
  resetProbeCorrelations: () => void;
  syncAppliedCalibration: () => void;
  maybeStartProbeCalibration: (nowMs: number) => void;
  reportTimingStatus: () => void;
  reportSourceStatus: () => void;
};

export function createRelayManualBootRecalibrationCoordinator(
  dependencies: RelayManualBootRecalibrationDependencies,
) {
  return {
    restart(nowMs: number) {
      dependencies.clearContentValidation();
      dependencies.beginExternalRecalibration();
      // Keep the previously confirmed authority interpreted under its own
      // strategy before the replacement candidate switches orchestration kind.
      // The candidate must not revoke a known-good content alignment merely by
      // announcing that the next measurement will use boot probes.
      dependencies.syncAppliedCalibration();
      dependencies.beginManualBootProbe();
      dependencies.abandonProbeRun();
      dependencies.resetProbeCorrelations();
      dependencies.maybeStartProbeCalibration(nowMs);
      dependencies.reportTimingStatus();
      dependencies.reportSourceStatus();
    },
  };
}
