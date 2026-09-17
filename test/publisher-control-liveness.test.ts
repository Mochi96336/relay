import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

function health(captureGeneration: number): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration,
    capturedSamples: 96_000,
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

function fakeSocket(participantId = 'participant-alice') {
  const sent: string[] = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  let terminated = 0;
  const socket = {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId,
    send(data: unknown) {
      sent.push(String(data));
    },
    close(code?: number, reason?: string) {
      closed.push({ code, reason });
    },
    terminate() {
      terminated += 1;
    },
  } as unknown as RelaySocket;
  return { socket, sent, closed, terminated: () => terminated };
}

function runtime(timeoutMs = 40) {
  return new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    uplinkHealthTimeoutMs: timeoutMs,
  });
}

function bindV2(mic: MicRuntime, socket: RelaySocket, generation = 7) {
  mic.bindPublisher({
    socket,
    sampleRate: 48_000,
    captureGeneration: generation,
    audioPacketVersion: 2,
    nowMs: 100,
  });
}

test('accepted current-generation uplink health renews the lease and gets an application ack', () => {
  const mic = runtime(1_000);
  const current = fakeSocket();
  bindV2(mic, current.socket, 7);

  assert.equal(mic.noteUplinkHealth(current.socket, health(7), 200), true);
  assert.equal(current.sent.length, 1);
  assert.deepEqual(JSON.parse(current.sent[0]), {
    type: 'audio-uplink-health-ack',
    version: 1,
    captureGeneration: 7,
  });

  assert.equal(mic.noteUplinkHealth(current.socket, health(6), 250), false);
  assert.equal(current.sent.length, 1, 'wrong-generation health must not produce a freshness ack');
  mic.detachPublisher(current.socket);
});

test('a v2 publisher control socket is closed when application health stops advancing', async () => {
  const mic = runtime(25);
  const current = fakeSocket();
  bindV2(mic, current.socket, 9);

  await new Promise((resolve) => setTimeout(resolve, 80));

  assert.deepEqual(current.closed, [{ code: 4000, reason: 'publisher uplink health stale' }]);
  assert.equal(current.terminated(), 0);
  mic.detachPublisher(current.socket);
});

test('legacy v1 publisher sockets keep the existing transport heartbeat contract', async () => {
  const mic = runtime(20);
  const legacy = fakeSocket();
  mic.bindPublisher({
    socket: legacy.socket,
    sampleRate: 48_000,
    captureGeneration: null,
    audioPacketVersion: 1,
    nowMs: 100,
  });

  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(legacy.closed.length, 0);
  assert.equal(legacy.terminated(), 0);
  mic.detachPublisher(legacy.socket);
});

test('replacing a publisher moves the liveness lease to the new physical socket', async () => {
  const mic = runtime(35);
  const first = fakeSocket();
  const replacement = fakeSocket();
  bindV2(mic, first.socket, 12);

  await new Promise((resolve) => setTimeout(resolve, 15));
  bindV2(mic, replacement.socket, 12);
  await new Promise((resolve) => setTimeout(resolve, 70));

  assert.equal(first.closed.length, 0, 'an old deadline must never close a replacement socket');
  assert.deepEqual(replacement.closed, [{ code: 4000, reason: 'publisher uplink health stale' }]);
  mic.detachPublisher(replacement.socket);
});
