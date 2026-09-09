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

      // Clearing the current mapping is not enough: the reference frame itself
      // is void. The Source generation must advance before old content evidence
      // can become eligible again, otherwise a previously confirmed result can
      // still match the live context and be re-applied after a fresh delta.
      dependencies.invalidateSourceMapping();

      // Discard an idle primed backup before aborting a collecting run. A
      // collecting CalibrationSession keeps its own working evidence; the
      // generation fence above already prevents any primed evidence from being
      // reused in a reference frame where it was not measured.
      dependencies.discardPrimedContent();
      dependencies.clearContentValidation();

      // Analysis is asynchronous. A worker that survives this generation change
      // would otherwise promote evidence captured in the retired frame while
      // stamping it with the context that is live when analysis completes.
      dependencies.abortCalibrationIfCollecting(reason);

      dependencies.syncAppliedCalibration();
      dependencies.reportSourceStatus();
      dependencies.reportTimingStatus();
    },
  };
}
