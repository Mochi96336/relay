import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

type AckSocket = RelaySocket & { sent: string[] };

function socket(participantId = 'alice'): AckSocket {
  const sent: string[] = [];
  return {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId,
    sent,
    send(payload: string) { sent.push(String(payload)); },
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

function lastAck(target: AckSocket) {
  assert.ok(target.sent.length > 0);
  return JSON.parse(target.sent.at(-1)!);
}

function bind(mic: MicRuntime, target: AckSocket, generation: number, sampleRate = 44_100) {
  return mic.bindPublisher({
    socket: target,
    sampleRate,
    captureGeneration: generation,
    audioPacketVersion: 2,
    nowMs: 0,
  });
}

test('configured MicRuntime ACKs cumulative post-session sample progress with both clock rates', () => {
  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    acceptedSampleRate: 48_000,
  });
  const first = socket();
  bind(mic, first, 7);

  assert.equal(mic.noteUplinkHealth(first, health(7, 0), 10), true);
  assert.deepEqual(lastAck(first).pcm, {
    acceptedFrameSerial: 0,
    acceptedSampleCount: 0,
    acceptedSampleRate: 48_000,
    captureSampleRate: 44_100,
    mediaPath: 'websocket',
  });

  mic.noteFrame(20, 480);
  mic.noteFrame(30, 240);
  assert.equal(mic.acceptedFrameSerial, 2);
  assert.equal(mic.acceptedSampleCount, 720);
  assert.equal(mic.noteUplinkHealth(first, health(7, 882), 40), true);
  assert.equal(lastAck(first).pcm.acceptedSampleCount, 720);

  assert.equal(mic.detachPublisher(first), true);
  const replacement = socket();
  const rebound = bind(mic, replacement, 7);
  assert.equal(rebound.preservedAudioTransport, true);
  assert.equal(mic.acceptedSampleCount, 720, 'same-capture socket replacement preserves coverage frontier');

  const fresh = socket();
  const replaced = bind(mic, fresh, 8);
  assert.equal(replaced.preservedAudioTransport, false);
  assert.equal(mic.acceptedFrameSerial, 0);
  assert.equal(mic.acceptedSampleCount, 0, 'new capture generation starts a fresh coverage frontier');
});

test('sample-progress authority fails closed if production forgets the accepted sample count', () => {
  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    acceptedSampleRate: 48_000,
  });
  bind(mic, socket(), 7, 48_000);
  assert.throws(
    () => mic.noteFrame(10),
    /requires positive acceptedSamples/,
  );
});
