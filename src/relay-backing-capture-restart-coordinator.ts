export type RelayBackingCaptureRestartInput = {
  calibrationCollecting: boolean;
};

export type RelayBackingCaptureRestartDependencies = {
  clearBackingBoundaryRequest: () => void;
  noteQualityEvent: (event: 'backing-capture-restarted') => void;
  abandonProbeRun: () => void;
  clearContentValidation: () => void;
  failCalibration: (message: string) => void;
  syncAppliedCalibration: () => void;
  reportTimingStatus: () => void;
  reportSourceStatus: () => void;
};

const CAPTURE_RESTART_CALIBRATION_MESSAGE =
  'Backing capture restarted during calibration. Start calibration again.';

/**
 * Orders effects after the audio uplink path has already established that the
 * Backing capture generation changed. Generation detection and calibration
 * authority stay in the existing runtimes behind server-owned callbacks.
 */
export function createRelayBackingCaptureRestartCoordinator(
  dependencies: RelayBackingCaptureRestartDependencies,
) {
  return {
    restart(input: RelayBackingCaptureRestartInput) {
      dependencies.clearBackingBoundaryRequest();
      dependencies.noteQualityEvent('backing-capture-restarted');
      dependencies.abandonProbeRun();
      dependencies.clearContentValidation();

      if (input.calibrationCollecting) {
        dependencies.failCalibration(CAPTURE_RESTART_CALIBRATION_MESSAGE);
        return;
      }

      dependencies.syncAppliedCalibration();
      dependencies.reportTimingStatus();
      dependencies.reportSourceStatus();
    },
  };
}
