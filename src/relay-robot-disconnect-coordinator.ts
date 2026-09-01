type RelayRobotDisconnectCoordinatorOptions<TSocket> = {
  isActive(socket: TSocket): boolean;
  noteDisconnected(): void;
  detach(socket: TSocket): void;
  resetPlayerOffset(): void;
  resetContentTimeline(): void;
  clearBackingBoundaryRequest(): void;
  abandonProbeRun(): void;
  syncAppliedCalibration(): void;
  reportSourceStatus(): void;
  reportTimingStatus(): void;
};

/**
 * Preserves Robot-source disconnect effect ordering without owning Robot identity,
 * source lifecycle, timing state, calibration state, or broadcast authority.
 * Every authority decision and domain mutation remains in server-supplied callbacks.
 */
export function createRelayRobotDisconnectCoordinator<TSocket>(
  options: RelayRobotDisconnectCoordinatorOptions<TSocket>,
) {
  return {
    handle(socket: TSocket) {
      if (!options.isActive(socket)) return false;

      options.noteDisconnected();
      options.detach(socket);
      options.resetPlayerOffset();
      options.resetContentTimeline();
      options.clearBackingBoundaryRequest();
      options.abandonProbeRun();
      options.syncAppliedCalibration();
      options.reportSourceStatus();
      options.reportTimingStatus();
      return true;
    },
  } as const;
}
