export type RelayRegistrationPayload = Record<string, unknown>;

type RelayRegistrationHandler<TSocket> = (
  socket: TSocket,
  payload: RelayRegistrationPayload,
) => void;

type RelayRegistrationProtocolHandlers<TSocket> = {
  publisher: RelayRegistrationHandler<TSocket>;
  backing: RelayRegistrationHandler<TSocket>;
  monitor: RelayRegistrationHandler<TSocket>;
};

/**
 * Selects known registration messages without owning role, participant,
 * transport, session, or runtime state. Server-supplied handlers retain all
 * validation, authority, replacement, and registration effects.
 */
export function createRelayRegistrationProtocol<TSocket>(
  handlers: RelayRegistrationProtocolHandlers<TSocket>,
) {
  return {
    dispatch(socket: TSocket, payload: RelayRegistrationPayload) {
      if (payload.type !== 'register') return false;

      switch (payload.role) {
        case 'publisher':
          handlers.publisher(socket, payload);
          return true;
        case 'backing':
          handlers.backing(socket, payload);
          return true;
        case 'monitor':
          handlers.monitor(socket, payload);
          return true;
        default:
          return false;
      }
    },
  } as const;
}
