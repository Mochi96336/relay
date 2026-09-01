type RelayBackingDisconnectCoordinatorOptions<TSocket> = {
  isBacking(socket: TSocket): boolean;
  noteDisconnected(): void;
  clearRobotBackingBoundaryRequest(): void;
  detach(socket: TSocket): void;
  clearBackingExpectation(): void;
  failCalibrationIfCollecting(): void;
  cancelContentValidationAndReport(): void;
  reportSourceStatus(): void;
  reportStatus(): void;
};

/**
 * Preserves Backing control-socket disconnect ordering without owning Backing
 * identity, Robot transition state, AudioSession state, calibration/validation
 * state, Take state, or broadcast authority. Those decisions remain callbacks
 * supplied by the server composition root.
 */
export function createRelayBackingDisconnectCoordinator<TSocket>(
  options: RelayBackingDisconnectCoordinatorOptions<TSocket>,
) {
  return {
    handle(socket: TSocket) {
      if (!options.isBacking(socket)) return false;

      options.noteDisconnected();
      options.clearRobotBackingBoundaryRequest();
      options.detach(socket);
      options.clearBackingExpectation();
      options.failCalibrationIfCollecting();
      options.cancelContentValidationAndReport();
      options.reportSourceStatus();
      options.reportStatus();
      return true;
    },
  } as const;
}
