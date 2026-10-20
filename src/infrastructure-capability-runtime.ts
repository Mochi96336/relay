export type InfrastructureCapabilitySocket = {
  participantId?: string;
  infrastructureAuthenticated?: boolean;
};

export type InfrastructureCapabilityRuntimeOptions = {
  key: string | null;
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

  constructor(options: InfrastructureCapabilityRuntimeOptions) {
    this.#key = options.key;
  }

  authenticated(socket: Socket) {
    return socket.infrastructureAuthenticated === true;
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
