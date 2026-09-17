import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

type AckSocket = RelaySocket & { sent: string[] };

function socket(participantId: string): AckSocket {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId,
    sent,
    send(payload: string) {
      sent.push(String(payload));
    },
  } as AckSocket;
}

function health(captureGeneration: number, capturedSamples: number): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration,
    capturedSamples,
    inputGapSamples: 0,
    inputMuted: false,
    capture: null,
    captureLevel: null,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path: 'websocket',
      maxPacketBytes: null,
      minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null,
      datagramPacketBytesCeiling: null,
      datagramQueuePackets: null,
      webTransportAttempts: 0,
      webTransportConnections: 0,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
    },
  };
}

function lastAck(socket: AckSocket) {
  assert.ok(socket.sent.length > 0);
  return JSON.parse(socket.sent.at(-1)!);
}

test('health ACK reports only server-accepted frame progress and preserves it across same-capture reconnect', () => {
  let nextTicket = 0;
  const connectedTickets = new Set<string>();
  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    createDirectMediaTicket: () => `ticket-${++nextTicket}`,
    directMediaConnected: (ticket) => Boolean(ticket && connectedTickets.has(ticket)),
    offerDirectMedia: (ticket) => ({ ticket }),
  });

  const first = socket('alice');
  mic.bindPublisher({
    socket: first,
    sampleRate: 48_000,
    captureGeneration: 7,
    audioPacketVersion: 2,
    nowMs: 100,
  });
  assert.equal(mic.acceptedFrameSerial, 0);

  assert.equal(mic.noteUplinkHealth(first, health(7, 1_000), 110), true);
  assert.deepEqual(lastAck(first).pcm, {
    acceptedFrameSerial: 0,
    mediaPath: 'websocket',
  });

  mic.noteFrame(120);
  mic.noteFrame(130);
  assert.equal(mic.acceptedFrameSerial, 2);
  assert.equal(mic.noteUplinkHealth(first, health(7, 2_000), 140), true);
  assert.equal(lastAck(first).pcm.acceptedFrameSerial, 2);

  const ticket = mic.mediaTicket;
  assert.ok(ticket);
  connectedTickets.add(ticket);
  assert.equal(mic.noteUplinkHealth(first, health(7, 3_000), 150), true);
  assert.equal(lastAck(first).pcm.mediaPath, 'webtransport');

  // Same participant + generation + sample rate preserves the accepted-frame
  // serial just like it preserves receiver/timeline continuity.
  connectedTickets.delete(ticket);
  assert.equal(mic.detachPublisher(first), true);
  const replacement = socket('alice');
  const rebound = mic.bindPublisher({
    socket: replacement,
    sampleRate: 48_000,
    captureGeneration: 7,
    audioPacketVersion: 2,
    nowMs: 200,
  });
  assert.equal(rebound.preservedAudioTransport, true);
  assert.equal(mic.acceptedFrameSerial, 2);
  assert.equal(mic.noteUplinkHealth(replacement, health(7, 4_000), 210), true);
  assert.deepEqual(lastAck(replacement).pcm, {
    acceptedFrameSerial: 2,
    mediaPath: 'websocket',
  });

  // A true capture replacement starts a new semantic progress counter.
  const fresh = socket('alice');
  const freshBind = mic.bindPublisher({
    socket: fresh,
    sampleRate: 48_000,
    captureGeneration: 8,
    audioPacketVersion: 2,
    nowMs: 300,
  });
  assert.equal(freshBind.preservedAudioTransport, false);
  assert.equal(freshBind.captureReplaced, true);
  assert.equal(mic.acceptedFrameSerial, 0);
  assert.equal(mic.noteUplinkHealth(fresh, health(8, 100), 310), true);
  assert.equal(lastAck(fresh).pcm.acceptedFrameSerial, 0);
});

test('old-generation health cannot receive current accepted-frame authority', () => {
  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
  });
  const current = socket('alice');
  mic.bindPublisher({
    socket: current,
    sampleRate: 48_000,
    captureGeneration: 9,
    audioPacketVersion: 2,
    nowMs: 100,
  });
  mic.noteFrame(110);

  assert.equal(mic.noteUplinkHealth(current, health(8, 1_000), 120), false);
  assert.equal(current.sent.length, 0);
  assert.equal(mic.noteUplinkHealth(current, health(9, 1_100), 130), true);
  assert.equal(lastAck(current).pcm.acceptedFrameSerial, 1);
});
