export type RelayProtocolPayload = Record<string, unknown>;

type RelayQueryProtocolOptions<Socket> = {
  sendJson: (socket: Socket, payload: unknown) => void;
  sessionStatusPayload: () => unknown;
  productStatusPayload: () => unknown;
  takeStatusPayload: () => unknown;
  roomSongStatusPayload: () => unknown;
  roomSongCommandStatusPayload: () => unknown;
  youtubeTimelineStatusPayload: () => unknown;
  sourceStatusPayload: () => unknown;
  timingCalibrationStatusPayload: () => unknown;
  wallClockMs?: () => number;
};

type QueryHandler<Socket> = (socket: Socket, payload: RelayProtocolPayload) => void;

/**
 * Owns read-only/control-plane query routing for the Relay text protocol.
 *
 * Domain owners still build every status payload. This adapter decides only
 * which already-owned query responder receives a message type, keeping the
 * WebSocket connection callback out of protocol-selection plumbing.
 */
export function createRelayQueryProtocol<Socket>(options: RelayQueryProtocolOptions<Socket>) {
  const wallClockMs = options.wallClockMs ?? Date.now;
  const handlers = new Map<string, QueryHandler<Socket>>([
    ['clock-ping', (socket, payload) => {
      const serverReceivedAtMs = wallClockMs();
      options.sendJson(socket, {
        type: 'clock-pong',
        id: payload.id,
        clientSentAtMs: payload.clientSentAtMs,
        serverReceivedAtMs,
        serverSentAtMs: wallClockMs(),
      });
    }],
    ['session-status-request', (socket) => options.sendJson(socket, options.sessionStatusPayload())],
    ['product-status-request', (socket) => options.sendJson(socket, options.productStatusPayload())],
    ['take-status-request', (socket) => options.sendJson(socket, options.takeStatusPayload())],
    ['room-song-status-request', (socket) => options.sendJson(socket, options.roomSongStatusPayload())],
    ['room-song-command-status-request', (socket) => options.sendJson(socket, options.roomSongCommandStatusPayload())],
    ['youtube-timeline-request', (socket) => options.sendJson(socket, options.youtubeTimelineStatusPayload())],
    ['source-status-request', (socket) => options.sendJson(socket, options.sourceStatusPayload())],
    ['timing-calibration-status-request', (socket) => options.sendJson(socket, options.timingCalibrationStatusPayload())],
  ]);

  return {
    dispatch(socket: Socket, payload: RelayProtocolPayload) {
      if (typeof payload.type !== 'string') return false;
      const handler = handlers.get(payload.type);
      if (!handler) return false;
      handler(socket, payload);
      return true;
    },
  } as const;
}
