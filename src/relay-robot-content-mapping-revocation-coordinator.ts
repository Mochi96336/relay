export type RelayRobotContentMappingRevocationDependencies = {
  resetPlayerOffset: () => void;
  resetContentTimeline: () => void;
  clearContentTransition: () => void;
  invalidateSourceMapping: () => void;
  discardPrimedContent: () => void;
  clearContentValidation: () => void;
  abortCalibrationIfCollecting: (reason: string) => void;
  syncAppliedCalibration: () => void;
  reportSourceStatus: () => void;
  reportTimingStatus: () => void;
};

/**
 * Orders the effects of invalidating the Robot media reference frame.
 *
 * Mapping, source, calibration and publication authority remain behind server
 * callbacks. This coordinator owns only the one teardown order that every
 * destructive mapping event must share.
 */
export function createRelayRobotContentMappingRevocationCoordinator(
  dependencies: RelayRobotContentMappingRevocationDependencies,
) {
  return {
    revoke(reason: string) {
      dependencies.resetPlayerOffset();
      dependencies.resetContentTimeline();
      dependencies.clearContentTransition();
      dependencies.invalidateSourceMapping();
      dependencies.discardPrimedContent();
      dependencies.clearContentValidation();
      dependencies.abortCalibrationIfCollecting(reason);
      dependencies.syncAppliedCalibration();
      dependencies.reportSourceStatus();
      dependencies.reportTimingStatus();
    },
  };
}
