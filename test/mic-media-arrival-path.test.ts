import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

function publisherSocket() {
  return {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId: 'alice',
    send() {},
  } as unknown as RelaySocket;
}

function packet(sequence: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation: 7,
    sequence,
    firstSampleIndex: sequence * 480,
    pcm: Buffer.alloc(960),
  });
}

function runtime() {
  let ticket: string | null = null;
  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    createDirectMediaTicket: () => {
      ticket = 'ticket-1';
      return ticket;
    },
    // The direct session is up the whole time, as on 2026-10-09.
    directMediaConnected: (candidate) => candidate !== null && candidate === ticket,
    offerDirectMedia: (candidate) => ({ ticket: candidate }),
  });
  const socket = publisherSocket();
  mic.bindPublisher({ socket, sampleRate: 48_000, captureGeneration: 7, audioPacketVersion: 2, nowMs: 0 });
  return { mic, socket, ticket: () => ticket };
}

test('Mic audio sent over WebSocket while a WebTransport session is merely open reads websocket', () => {
  const { mic, socket } = runtime();
  assert.equal(mic.mediaPath(), 'webtransport', 'the connected path, which health ACKs keep carrying');
  assert.equal(mic.mediaArrivalPath(10), 'webtransport', 'before any audio, the connected path');

  mic.receivePublisher(socket, packet(0), 100);
  assert.equal(mic.mediaArrivalPath(150), 'websocket');
  assert.equal(mic.mediaPath(), 'webtransport', 'the ACK path is unchanged');
});

test('the arrival path follows the latest packet and falls back once packets stop', () => {
  const { mic, socket, ticket } = runtime();
  mic.receivePublisher(socket, packet(0), 100);
  mic.receiveDirectMedia(ticket(), packet(1), 200);
  assert.equal(mic.mediaArrivalPath(250), 'webtransport');
  mic.receivePublisher(socket, packet(2), 300);
  assert.equal(mic.mediaArrivalPath(350), 'websocket');
  assert.equal(mic.mediaArrivalPath(1_301), 'webtransport', 'stale arrivals give way to the connected path');
});
