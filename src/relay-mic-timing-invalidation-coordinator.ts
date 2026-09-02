export type RelayMicTimingInvalidationDependencies = {
  clearBootCalibration: () => void;
  clearContentValidation: () => void;
  invalidateCalibration: (message: string) => void;
  clearTimingKind: () => void;
  resetAutoCalibrationSchedule: () => void;
  syncAppliedCalibration: () => void;
  reportTimingStatus: () => void;
  reportSourceStatus: () => void;
};

/**
 * Orders adapter effects after the server has decided Mic timing authority is
 * invalid. Calibration state and runtime authority stay behind server callbacks;
 * this coordinator only preserves teardown/publication ordering.
 */
export function createRelayMicTimingInvalidationCoordinator(
  dependencies: RelayMicTimingInvalidationDependencies,
) {
  return {
    invalidate(message: string) {
      dependencies.clearBootCalibration();
      dependencies.clearContentValidation();
      dependencies.invalidateCalibration(message);
      dependencies.clearTimingKind();
      dependencies.resetAutoCalibrationSchedule();
      dependencies.syncAppliedCalibration();
      dependencies.reportTimingStatus();
      dependencies.reportSourceStatus();
    },
  };
}
