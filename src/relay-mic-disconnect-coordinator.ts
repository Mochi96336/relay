type RelayMicDisconnectCoordinatorOptions<TSocket> = {
  isPublisher(socket: TSocket): boolean;
  noteDisconnected(): void;
  reconnectingOwnerId(socket: TSocket): string | null;
  detachPublisher(socket: TSocket): void;
  clearMediaAuthority(): void;
  preserveMediaForReconnect(ownerId: string): void;
  maybeStopLiveSourceWhenUnarmed(): void;
  failCalibrationIfCollecting(): void;
  cancelContentValidationAndReport(): void;
  reportStatus(): void;
};

/**
 * Preserves Mic control-socket disconnect ordering without owning Mic identity,
 * participant ownership, media authority, reconnect grace, calibration state,
 * live-source policy, or broadcasts. Those decisions remain server callbacks.
 */
export function createRelayMicDisconnectCoordinator<TSocket>(
  options: RelayMicDisconnectCoordinatorOptions<TSocket>,
) {
  return {
    handle(socket: TSocket) {
      if (!options.isPublisher(socket)) return false;

      options.noteDisconnected();
      const reconnectingOwnerId = options.reconnectingOwnerId(socket);
      options.detachPublisher(socket);

      if (reconnectingOwnerId) {
        options.preserveMediaForReconnect(reconnectingOwnerId);
      } else {
        options.clearMediaAuthority();
        options.maybeStopLiveSourceWhenUnarmed();
      }

      options.failCalibrationIfCollecting();
      options.cancelContentValidationAndReport();
      options.reportStatus();
      return true;
    },
  } as const;
}
