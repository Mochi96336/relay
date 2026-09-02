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
      dependencies.beginManualBootProbe();
      dependencies.abandonProbeRun();
      dependencies.resetProbeCorrelations();
      dependencies.syncAppliedCalibration();
      dependencies.maybeStartProbeCalibration(nowMs);
      dependencies.reportTimingStatus();
      dependencies.reportSourceStatus();
    },
  };
}
