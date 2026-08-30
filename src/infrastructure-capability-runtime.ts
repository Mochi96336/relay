export type InfrastructureCapabilitySocket = {
  participantId?: string;
  infrastructureAuthenticated?: boolean;
};

export type InfrastructureCapabilityRuntimeOptions = {
  key: string | null;
  legacyAuthorized?: boolean;
};

/**
 * Owns the infrastructure capability bound to a physical Relay socket.
 *
 * This is security state only. It does not choose a transport role, grant Mic
 * or Song authority, send protocol messages, or close sockets. Those effects
 * remain with the server composition root.
 */
export class InfrastructureCapabilityRuntime<
  Socket extends InfrastructureCapabilitySocket,
> {
  readonly #key: string | null;
  readonly #legacyAuthorized: boolean;

  constructor(options: InfrastructureCapabilityRuntimeOptions) {
    this.#key = options.key;
    this.#legacyAuthorized = options.legacyAuthorized === true;
  }

  authenticated(socket: Socket) {
    return socket.infrastructureAuthenticated === true;
  }

  authorized(socket: Socket) {
    return this.authenticated(socket) || this.#legacyAuthorized;
  }

  authenticate(socket: Socket, suppliedKey: unknown) {
    if (
      socket.participantId !== undefined
      || this.#key === null
      || suppliedKey !== this.#key
    ) {
      return false;
    }

    socket.infrastructureAuthenticated = true;
    return true;
  }
}
