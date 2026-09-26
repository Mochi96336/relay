import type { IncomingMessage, Server as HttpServer } from 'node:http';

import WebSocket, { WebSocketServer } from 'ws';

import {
  MONITOR_UNACKNOWLEDGED_PROBE_MS,
  monitorFrameWouldExceedBacklog,
  monitorUnacknowledgedSamples,
  type MonitorDelivery,
} from './monitor-backpressure.js';
import { encodePcmFrame, FRAME_HEADER_BYTES } from './pcm-frame.js';

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
  monitorDelivery?: MonitorDelivery;
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
  maxPayloadBytes?: number;
};

/**
 * Largest single inbound WebSocket message, in bytes.
 *
 * `ws` otherwise accepts 100 MiB and buffers all of it before any handler can
 * look at it, so one oversized message from any socket that passed the room
 * key costs the Relay host that much memory. Relay's largest real messages are
 * PCM frames: 20 ms is under 2 KB, and even a 1 s Backing frame at 192 kHz is
 * 384 KB. Anything past this is closed with 1009 (message too big).
 */
export const DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES = 1024 * 1024;

export type MonitorFramePosition = {
  generation: number;
  firstSampleIndex: number;
};

export type MonitorSocketTransportOptions = {
  backlogBytes: number;
  /**
   * Positioned PCM a monitor that confirms delivery may have outstanding, in
   * mix samples. Past it, frames for that monitor are dropped until it
   * catches up. See monitorUnacknowledgedSamples.
   */
  unacknowledgedSamples?: number;
  nowMs?: () => number;
};

/**
 * How far back a monitor backlog drop still describes a listener that is
 * behind now. The lifetime total never falls, so one slow phone that has since
 * recovered, or left, would otherwise read as a current room fault.
 */
export const MONITOR_RECENT_DROP_WINDOW_MS = 10_000;

export type MonitorRecentDrops = {
  /** PCM frames dropped for any listener within the window. */
  frames: number;
  /** Listeners still connected that had a frame dropped within the window. */
  listeners: number;
  windowMs: number;
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
   * Physically retires one transport after server/domain policy has decided it
   * is replaced. The delayed terminate is only a close-handshake backstop; it
   * carries no authority decision of its own.
   */
  function retire(socket: RelaySocket, payload: unknown) {
    socket.replaced = true;
    sendJson(socket, payload);
    try {
      socket.close();
    } catch {}
    setTimeout(() => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }, 1_000).unref();
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
    retire,
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
  if (
    options.unacknowledgedSamples !== undefined
    && (!Number.isFinite(options.unacknowledgedSamples) || options.unacknowledgedSamples <= 0)
  ) {
    throw new Error('MonitorSocketTransport unacknowledgedSamples must be positive.');
  }

  let droppedFrames = 0;
  const nowMs = options.nowMs ?? (() => performance.now());
  const recentDrops: { atMs: number; socket: RelaySocket }[] = [];

  function pruneRecentDrops(atMs: number) {
    let expired = 0;
    while (
      expired < recentDrops.length
      && atMs - recentDrops[expired].atMs >= MONITOR_RECENT_DROP_WINDOW_MS
    ) expired += 1;
    if (expired > 0) recentDrops.splice(0, expired);
  }

  function noteDrop(socket: RelaySocket) {
    droppedFrames += 1;
    const atMs = nowMs();
    pruneRecentDrops(atMs);
    recentDrops.push({ atMs, socket });
  }

  function broadcast(
    payload: string | Buffer,
    binary = false,
    position: MonitorFramePosition | null = null,
  ) {
    // Every positioned monitor gets the same bytes, so frame them once per
    // broadcast rather than once per listener. The sockets only read them.
    let framed: Buffer | null = null;
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
        ? (framed ??= encodePcmFrame(position.generation, position.firstSampleIndex, payload))
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
        noteDrop(socket);
        continue;
      }

      const positioned = outbound === framed && framed !== null && position !== null;
      if (positioned && options.unacknowledgedSamples !== undefined && socket.monitorDelivery) {
        const outstanding = monitorUnacknowledgedSamples(socket.monitorDelivery);
        const sentAtMs = socket.monitorDelivery.sentAtMs;
        const probeDue = sentAtMs === null || nowMs() - sentAtMs >= MONITOR_UNACKNOWLEDGED_PROBE_MS;
        if (outstanding !== null && outstanding > options.unacknowledgedSamples && !probeDue) {
          // The listener is that far behind somewhere this process cannot
          // see. The hole this leaves makes it drop what it queued and
          // rejoin the live edge once the backlog has drained.
          noteDrop(socket);
          continue;
        }
      }
      socket.send(outbound, { binary });
      if (positioned) {
        socket.monitorDelivery ??= { sent: null, acknowledged: null, sentAtMs: null };
        socket.monitorDelivery.sentAtMs = nowMs();
        socket.monitorDelivery.sent = {
          generation: position.generation,
          endSampleIndex: position.firstSampleIndex + (framed!.byteLength - FRAME_HEADER_BYTES) / 2,
        };
      }
    }
  }

  /**
   * Records a Listen page's confirmation of the positioned PCM it received,
   * which opts that monitor into acknowledged delivery. True when the payload
   * was a monitor acknowledgement, valid or not.
   */
  function acknowledge(socket: RelaySocket, payload: Record<string, unknown>) {
    if (payload.type !== 'monitor-ack') return false;
    const generation = payload.generation;
    const endSampleIndex = payload.receivedEndSampleIndex;
    if (
      socket.role !== 'monitor'
      || socket.monitorPacketVersion !== 1
      || typeof generation !== 'number'
      || !Number.isInteger(generation)
      || generation < 0
      || generation > 0xffff_ffff
      || typeof endSampleIndex !== 'number'
      || !Number.isSafeInteger(endSampleIndex)
      || endSampleIndex < 0
    ) return true;
    socket.monitorDelivery ??= { sent: null, acknowledged: null, sentAtMs: null };
    const previous = socket.monitorDelivery.acknowledged;
    // Acknowledgements travel in order on one socket; never move one back.
    if (
      previous
      && previous.generation === generation
      && previous.endSampleIndex >= endSampleIndex
    ) return true;
    socket.monitorDelivery.acknowledged = { generation, endSampleIndex };
    return true;
  }

  return {
    broadcast,
    acknowledge,
    /** Lifetime total across every listener; see recentDrops() for now. */
    get droppedFrames() {
      return droppedFrames;
    },
    recentDrops(atMs = nowMs()): MonitorRecentDrops {
      pruneRecentDrops(atMs);
      const listeners = new Set<RelaySocket>();
      for (const drop of recentDrops) {
        if (drop.socket.readyState === WebSocket.OPEN) listeners.add(drop.socket);
      }
      return {
        frames: recentDrops.length,
        listeners: listeners.size,
        windowMs: MONITOR_RECENT_DROP_WINDOW_MS,
      };
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
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: options.maxPayloadBytes ?? DEFAULT_WEBSOCKET_MAX_PAYLOAD_BYTES,
  });
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

    // `ws` reports a protocol violation from the peer (invalid UTF-8, a bad
    // opcode, an oversized message) as an 'error' event on this socket after
    // it has already started closing it. With no listener, Node rethrows that
    // event and one malformed frame from any client takes the whole room down.
    // The socket is already on its way out; there is nothing else to do.
    socket.on('error', () => {});
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
