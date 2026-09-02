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
