export type RelayAuthenticationPayload = Record<string, unknown>;

type RelayAuthenticationHandler<TSocket> = (
  socket: TSocket,
  payload: RelayAuthenticationPayload,
) => void;

type RelayAuthenticationProtocolHandlers<TSocket> = {
  infrastructureAuthenticate: RelayAuthenticationHandler<TSocket>;
  participantAuthenticate: RelayAuthenticationHandler<TSocket>;
};

/**
 * Selects authentication messages without owning identity or capability state.
 * The server-supplied handlers remain responsible for validation, attachment,
 * rejection, and transport-close effects.
 */
export function createRelayAuthenticationProtocol<TSocket>(
  handlers: RelayAuthenticationProtocolHandlers<TSocket>,
) {
  return {
    dispatch(socket: TSocket, payload: RelayAuthenticationPayload) {
      switch (payload.type) {
        case 'infrastructure-authenticate':
          handlers.infrastructureAuthenticate(socket, payload);
          return true;
        case 'participant-authenticate':
          handlers.participantAuthenticate(socket, payload);
          return true;
        default:
          return false;
      }
    },
  } as const;
}
