export type RelayLiveSourceStopDependencies = {
  cancelBackingGrace: () => void;
  retireRobotRoute: () => void;
  sessionActive: () => boolean;
  endTakeMix: () => void;
  clearBootCalibration: () => void;
  clearContentValidation: () => void;
  resetRobotPlayerOffset: () => void;
  resetRobotContentTimeline: () => void;
  clearRobotBackingBoundaryRequest: () => void;
  stopSession: () => void;
  resetCalibration: () => void;
  clearTimingKind: () => void;
  resetAutoCalibrationSchedule: () => void;
  reportTimingStatus: () => void;
  reportSourceStatus: () => void;
  reportStatus: () => void;
};

/**
 * Orders the adapter teardown for the authoritative live source after callers
 * have decided the route should stop. Domain state and authority stay in the
 * server callbacks; this coordinator preserves the cross-domain ordering only.
 *
 * Backing grace and Robot-route retirement deliberately happen even when the
 * audio session is already inactive. That keeps a stale route from remaining
 * armed just because there is no active mixer to stop.
 */
export function createRelayLiveSourceStopCoordinator(
  dependencies: RelayLiveSourceStopDependencies,
) {
  return {
    stop() {
      dependencies.cancelBackingGrace();
      dependencies.retireRobotRoute();
      if (!dependencies.sessionActive()) return false;

      dependencies.endTakeMix();
      dependencies.clearBootCalibration();
      dependencies.clearContentValidation();
      dependencies.resetRobotPlayerOffset();
      dependencies.resetRobotContentTimeline();
      dependencies.clearRobotBackingBoundaryRequest();
      dependencies.stopSession();
      dependencies.resetCalibration();
      dependencies.clearTimingKind();
      dependencies.resetAutoCalibrationSchedule();
      dependencies.reportTimingStatus();
      dependencies.reportSourceStatus();
      dependencies.reportStatus();
      return true;
    },
  };
}
