import type { IncomingMessage, Server as HttpServer } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

import { monitorFrameWouldExceedBacklog } from './monitor-backpressure.js';
import { encodePcmFrame } from './pcm-frame.js';

export type ClientRole = 'publisher' | 'monitor' | 'backing' | 'unknown';
type ClaimedClientRole = Exclude<ClientRole, 'unknown'>;

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
  connectionIncarnation: number;
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
  telemetryRejectedReason?: string;
  micPresenceTelemetryAt?: number;
  infrastructureAuthenticated?: boolean;
};

export type RelaySocketServerOptions = {
  path?: string;
  relayKey: string | null;
  heartbeatMs: number;
};

export type MonitorFramePosition = {
  generation: number;
  firstSampleIndex: number;
};

export type MonitorSocketTransportOptions = {
  backlogBytes: number;
};

/**
 * Binds transport-only helpers to one Relay WebSocket server.
 *
 * These helpers know only physical socket state. They do not decide whether a
 * participant may own the Mic, lead Song playback, control a Take, or hold any
 * other domain authority.
 */
export function createRelaySocketTransport(wss: WebSocketServer) {
  function sendJson(socket: WebSocket, payload: unknown) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  }

  function broadcastJson(payload: unknown) {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  /**
   * A physical media/monitor WebSocket may bind exactly one transport role.
   * Authentication says who may use it; playback identity remains orthogonal
   * because a participant's playback-control capability can intentionally live
   * on the same socket as its publisher transport. Reconnects get a new socket
   * instead of morphing publisher/backing/monitor while authority pointers still
   * reference the old transport.
   */
  function canClaimSocketRole(socket: RelaySocket, requestedRole: ClaimedClientRole) {
    if (socket.role === 'unknown' || socket.role === requestedRole) return true;
    sendJson(socket, {
      type: 'role-conflict',
      currentRole: socket.role,
      requestedRole,
    });
    return false;
  }

  function commitSocketRole(socket: RelaySocket, requestedRole: ClaimedClientRole) {
    if (socket.role !== 'unknown' && socket.role !== requestedRole) {
      throw new Error(`Cannot change WebSocket role from ${socket.role} to ${requestedRole}.`);
    }
    socket.role = requestedRole;
  }

  return {
    sendJson,
    broadcastJson,
    canClaimSocketRole,
    commitSocketRole,
  };
}
/**
 * Owns monitor-specific physical fanout: role filtering, positioned PCM wire
 * framing, and per-destination WebSocket backlog drops. The caller still owns
 * when a mix frame should be published and what that frame means.
 */
export function createMonitorSocketTransport(
  wss: WebSocketServer,
  options: MonitorSocketTransportOptions,
) {
  if (!Number.isFinite(options.backlogBytes) || options.backlogBytes <= 0) {
    throw new Error('MonitorSocketTransport backlogBytes must be positive.');
  }

  let droppedFrames = 0;

  function broadcast(
    payload: string | Buffer,
    binary = false,
    position: MonitorFramePosition | null = null,
  ) {
    for (const client of wss.clients) {
      const socket = client as RelaySocket;
      if (socket.role !== 'monitor' || socket.readyState !== WebSocket.OPEN) continue;

      // Once a monitor opts into positioned PCM, every binary packet must remain
      // framed. Do not silently fall back to raw PCM on an unpositioned path.
      if (binary && socket.monitorPacketVersion === 1 && position === null) continue;

      const outbound = binary
        && Buffer.isBuffer(payload)
        && socket.monitorPacketVersion === 1
        && position !== null
        ? encodePcmFrame(position.generation, position.firstSampleIndex, payload)
        : payload;

      if (
        binary
        && Buffer.isBuffer(outbound)
        && monitorFrameWouldExceedBacklog(
          socket.bufferedAmount,
          outbound.byteLength,
          options.backlogBytes,
        )
      ) {
        droppedFrames += 1;
        continue;
      }
      socket.send(outbound, { binary });
    }
  }

  return {
    broadcast,
    get droppedFrames() {
      return droppedFrames;
    },
  };
}

/**
 * Owns the physical WebSocket substrate only: HTTP upgrade admission, socket
 * liveness, and heartbeat cleanup. Message meaning, identity/auth authority,
 * and disconnect domain effects stay in server orchestration.
 */
export function createRelayWebSocketServer(
  server: HttpServer,
  options: RelaySocketServerOptions,
) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const socketPath = options.path ?? '/ws';
  let connectionSequence = 0;

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
    connectionSequence += 1;
    socket.connectionIncarnation = connectionSequence;
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
