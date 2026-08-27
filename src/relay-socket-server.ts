import type { IncomingMessage, Server as HttpServer } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

export type ClientRole = 'publisher' | 'monitor' | 'backing' | 'unknown';

/**
 * Transport-local metadata carried by one Relay WebSocket.
 *
 * Domain owners may attach participant/playback/source identity to the socket,
 * but the socket server owns connection liveness and the physical transport
 * role. Keeping the adapter shape here lets orchestration move without making
 * those fields part of any domain model.
 */
export type RelaySocket = WebSocket & {
  role: ClientRole;
  sampleRate?: number;
  captureGeneration?: number;
  audioPacketVersion?: 1 | 2;
  monitorPacketVersion?: 1;
  isAlive: boolean;
  replaced?: boolean;
  isRobotSource?: boolean;
  participantId?: string;
  participantConnectionId?: string;
  playbackParticipantId?: string;
  playbackTransportId?: string;
  playbackGeneration?: number;
  playbackMicIntentAtMs?: number;
  legacyPlaybackGeneration?: number;
  telemetryRejectedReason?: string;
  micPresenceTelemetryAt?: number;
  infrastructureAuthenticated?: boolean;
};

export type RelaySocketServerOptions = {
  path?: string;
  relayKey: string | null;
  heartbeatMs: number;
};

/**
 * Owns the physical WebSocket substrate only: HTTP upgrade admission, socket
 * liveness, and heartbeat cleanup. Message meaning, transport-role claims and
 * disconnect effects stay in server orchestration until those seams are moved
 * independently.
 */
export function createRelayWebSocketServer(
  server: HttpServer,
  options: RelaySocketServerOptions,
) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const socketPath = options.path ?? '/ws';

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname !== socketPath) {
      socket.destroy();
      return;
    }

    if (options.relayKey && url.searchParams.get('key') !== options.relayKey) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit('connection', webSocket, request);
    });
  });

  wss.on('connection', (rawSocket: WebSocket, _request: IncomingMessage) => {
    const socket = rawSocket as RelaySocket;
    socket.role = 'unknown';
    socket.isAlive = true;

    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', () => {
      socket.isAlive = true;
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const socket = client as RelaySocket;
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, options.heartbeatMs);

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return wss;
}
