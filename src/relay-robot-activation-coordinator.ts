export type RelayRobotActivationInput<TSocket> = {
  previous: TSocket | null;
  replaced: boolean;
};

export type RelayRobotActivationDependencies<TSocket> = {
  notifyPreviousReplaced: (previous: TSocket) => void;
  noteQualityEvent: (
    event: 'robot-source-replaced' | 'robot-source-connected',
  ) => void;
  abandonProbeRun: () => void;
  sessionActive: () => boolean;
  resetPlayerOffset: () => void;
  resetContentTimeline: () => void;
  clearBackingBoundaryRequest: () => void;
  /**
   * Replacing the active Robot source bumps the source generation, so a
   * calibration still in flight belongs to a reference frame that is gone. Its
   * async analysis is stamped with the context live at completion, so it has to
   * be aborted here rather than allowed to promote under the new generation.
   */
  failCalibrationIfCollecting: () => void;
  dropLegacyCalibrationForRobot: () => void;
  syncAppliedCalibration: () => void;
  reportSourceStatus: () => void;
  reportTimingStatus: () => void;
};

/**
 * Orders Robot source activation after SourceRuntime has already admitted and
 * attached the authoritative socket.
 *
 * Infrastructure authorization and SourceRuntime identity/generation authority
 * intentionally stay in the server composition root. This seam only sequences
 * the already-established replacement/connection effects and dependent timing
 * resets through server-supplied callbacks.
 */
export function createRelayRobotActivationCoordinator<TSocket>(
  dependencies: RelayRobotActivationDependencies<TSocket>,
) {
  return {
    activate(input: RelayRobotActivationInput<TSocket>) {
      if (input.replaced && input.previous) {
        dependencies.notifyPreviousReplaced(input.previous);
        dependencies.noteQualityEvent('robot-source-replaced');
        dependencies.abandonProbeRun();
        dependencies.failCalibrationIfCollecting();
      } else if (!input.previous && dependencies.sessionActive()) {
        dependencies.noteQualityEvent('robot-source-connected');
      }

      dependencies.resetPlayerOffset();
      dependencies.resetContentTimeline();
      dependencies.clearBackingBoundaryRequest();
      dependencies.dropLegacyCalibrationForRobot();
      dependencies.syncAppliedCalibration();
      dependencies.reportSourceStatus();
      dependencies.reportTimingStatus();
    },
  };
}
