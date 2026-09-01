export type RelayInfrastructureEventPayload = Record<string, unknown>;

type RelayInfrastructureEventHandler<TSocket> = (
  socket: TSocket,
  payload: RelayInfrastructureEventPayload,
) => void;

type RelayInfrastructureEventProtocolHandlers<TSocket> = {
  backingSampleBoundary: RelayInfrastructureEventHandler<TSocket>;
  robotPlayerOffset: RelayInfrastructureEventHandler<TSocket>;
};

/**
 * Selects already-authorized infrastructure observations without owning their
 * authority or effects. The server-supplied handlers remain responsible for
 * role/source validation and all Robot timing state transitions.
 */
export function createRelayInfrastructureEventProtocol<TSocket>(
  handlers: RelayInfrastructureEventProtocolHandlers<TSocket>,
) {
  return {
    dispatch(socket: TSocket, payload: RelayInfrastructureEventPayload) {
      switch (payload.type) {
        case 'backing-sample-boundary':
          handlers.backingSampleBoundary(socket, payload);
          return true;
        case 'robot-player-offset':
          handlers.robotPlayerOffset(socket, payload);
          return true;
        default:
          return false;
      }
    },
  } as const;
}
