export type RelayMicCaptureRestartInput = {
  calibrationCollecting: boolean;
};

export type RelayMicCaptureRestartDependencies = {
  noteQualityEvent: (event: 'mic-capture-restarted') => void;
  abandonProbeRun: () => void;
  clearContentValidation: () => void;
  failCalibration: (message: string) => void;
  syncAppliedCalibration: () => void;
  reportTimingStatus: () => void;
  reportSourceStatus: () => void;
};

const CAPTURE_RESTART_CALIBRATION_MESSAGE =
  'Microphone capture restarted during calibration. Start calibration again.';

/**
 * Orders adapter effects after AudioSession has already established that the
 * Mic capture generation changed. Generation detection and calibration
 * authority remain in the server/runtimes behind these callbacks.
 */
export function createRelayMicCaptureRestartCoordinator(
  dependencies: RelayMicCaptureRestartDependencies,
) {
  return {
    restart(input: RelayMicCaptureRestartInput) {
      dependencies.noteQualityEvent('mic-capture-restarted');
      dependencies.abandonProbeRun();
      dependencies.clearContentValidation();

      if (input.calibrationCollecting) {
        // CalibrationSession.fail() owns its settled publication callback, so
        // do not publish the same transition a second time from this path.
        dependencies.failCalibration(CAPTURE_RESTART_CALIBRATION_MESSAGE);
        return;
      }

      dependencies.syncAppliedCalibration();
      // Timing must be visible before source status for a new capture
      // generation, otherwise observers can briefly pair the new source with
      // stale applied timing.
      dependencies.reportTimingStatus();
      dependencies.reportSourceStatus();
    },
  };
}
