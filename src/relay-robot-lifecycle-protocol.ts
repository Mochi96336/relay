export type RelayRobotLifecyclePayload = Record<string, unknown>;

type RelayRobotLifecycleHandler<TSocket> = (
  socket: TSocket,
  payload: RelayRobotLifecyclePayload,
) => void;

type RelayRobotLifecycleProtocolHandlers<TSocket> = {
  robotSourceHello: RelayRobotLifecycleHandler<TSocket>;
};

/**
 * Selects Robot lifecycle messages without owning source identity or lifecycle state.
 * The server-supplied handler remains responsible for infrastructure authority,
 * Robot source replacement, timing resets, calibration effects, and broadcasts.
 */
export function createRelayRobotLifecycleProtocol<TSocket>(
  handlers: RelayRobotLifecycleProtocolHandlers<TSocket>,
) {
  return {
    dispatch(socket: TSocket, payload: RelayRobotLifecyclePayload) {
      if (payload.type !== 'robot-source-hello') return false;
      handlers.robotSourceHello(socket, payload);
      return true;
    },
  } as const;
}
