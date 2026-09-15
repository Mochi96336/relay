export const MIC_CAPTURE_CHANGED_TIMING_REASON = 'Microphone capture changed.' as const;

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
 *
 * A capture replacement is narrower than an ownership/route invalidation. The
 * old confirmed measurement is still useful history, but its capture context is
 * stale and must stop driving the mixer immediately. Capture-scoped Boot probe
 * and validation state are retired, while the confirmed calibration result,
 * timing strategy and retry schedule remain available to explain what changed.
 */
export function createRelayMicTimingInvalidationCoordinator(
  dependencies: RelayMicTimingInvalidationDependencies,
) {
  return {
    invalidate(message: string) {
      if (message === MIC_CAPTURE_CHANGED_TIMING_REASON) {
        dependencies.clearBootCalibration();
        dependencies.clearContentValidation();
        dependencies.syncAppliedCalibration();
        dependencies.reportTimingStatus();
        dependencies.reportSourceStatus();
        return;
      }

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
