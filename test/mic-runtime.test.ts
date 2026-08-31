import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

function socket(participantId: string): RelaySocket {
  return {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId,
  } as RelaySocket;
}

function uplinkHealth(captureGeneration: number, inputMuted = false): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration,
    capturedSamples: 1_000,
    inputGapSamples: 0,
    inputMuted,
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

function runtime() {
  let ticketSequence = 0;
  const activeTickets = new Set<string>();
  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    createDirectMediaTicket: () => `ticket-${++ticketSequence}`,
    directMediaConnected: (ticket) => Boolean(ticket && activeTickets.has(ticket)),
    offerDirectMedia: (ticket) => ({ ticket }),
  });
  return { mic, activeTickets };
}

test('same-capture reconnect preserves receiver continuity while a new capture resets it', () => {
  const { mic } = runtime();
  const first = socket('participant-alice');
  const firstBind = mic.bindPublisher({
    socket: first,
    sampleRate: 48_000,
    captureGeneration: 7,
    audioPacketVersion: 2,
    nowMs: 100,
  });
  assert.equal(firstBind.preservedAudioTransport, false);
  const firstTransport = mic.audioTransport;
  const firstTicket = mic.mediaTicket;
  assert.ok(firstTransport);
  assert.equal(firstTicket, 'ticket-1');

  assert.equal(mic.detachPublisher(first), true);
  const reconnected = socket('participant-alice');
  const reconnectBind = mic.bindPublisher({
    socket: reconnected,
    sampleRate: 48_000,
    captureGeneration: 7,
    audioPacketVersion: 2,
    nowMs: 200,
  });
  assert.equal(reconnectBind.previousPublisher, null);
  assert.equal(reconnectBind.sameParticipantReplacement, true);
  assert.equal(reconnectBind.sameCapture, true);
  assert.equal(reconnectBind.preservedAudioTransport, true);
  assert.equal(mic.audioTransport, firstTransport);
  assert.equal(mic.mediaTicket, firstTicket);

  const freshCapture = socket('participant-alice');
  const freshBind = mic.bindPublisher({
    socket: freshCapture,
    sampleRate: 48_000,
    captureGeneration: 8,
    audioPacketVersion: 2,
    nowMs: 300,
  });
  assert.equal(freshBind.sameParticipantReplacement, true);
  assert.equal(freshBind.sameCapture, false);
  assert.equal(freshBind.preservedAudioTransport, false);
  assert.notEqual(mic.audioTransport, firstTransport);
  assert.equal(mic.mediaGeneration, 8);
  assert.equal(mic.mediaTicket, 'ticket-2');
});

test('same generation with a different sample rate cannot inherit capture continuity', () => {
  const { mic } = runtime();
  const first = socket('participant-alice');
  mic.bindPublisher({
    socket: first,
    sampleRate: 48_000,
    captureGeneration: 12,
    audioPacketVersion: 2,
    nowMs: 100,
  });
  const originalTransport = mic.audioTransport;
  const originalTicket = mic.mediaTicket;
  assert.ok(originalTransport);
  assert.equal(originalTicket, 'ticket-1');

  assert.equal(mic.detachPublisher(first), true);
  const contradictoryReconnect = socket('participant-alice');
  const rebound = mic.bindPublisher({
    socket: contradictoryReconnect,
    sampleRate: 44_100,
    captureGeneration: 12,
    audioPacketVersion: 2,
    nowMs: 200,
  });

  assert.equal(rebound.previousPublisher, null);
  assert.equal(rebound.sameParticipantReplacement, true);
  assert.equal(rebound.sameCapture, false);
  assert.equal(rebound.preservedAudioTransport, false);
  assert.notEqual(mic.audioTransport, originalTransport);
  assert.equal(mic.sampleRate, 44_100);
  assert.equal(mic.mediaGeneration, 12);
  assert.equal(mic.mediaTicket, 'ticket-2');
});

test('same participant tab replacement preserves only the same v2 capture', () => {
  const { mic } = runtime();
  const first = socket('participant-alice');
  mic.bindPublisher({
    socket: first,
    sampleRate: 48_000,
    captureGeneration: 9,
    audioPacketVersion: 2,
    nowMs: 100,
  });
  const original = mic.audioTransport;

  const replacement = socket('participant-alice');
  const same = mic.bindPublisher({
    socket: replacement,
    sampleRate: 48_000,
    captureGeneration: 9,
    audioPacketVersion: 2,
    nowMs: 200,
  });
  assert.equal(same.sameParticipantReplacement, true);
  assert.equal(same.sameCapture, true);
  assert.equal(same.preservedAudioTransport, true);
  assert.equal(mic.audioTransport, original);

  const legacy = socket('participant-alice');
  const downgraded = mic.bindPublisher({
    socket: legacy,
    sampleRate: 48_000,
    captureGeneration: null,
    audioPacketVersion: 1,
    nowMs: 300,
  });
  assert.equal(downgraded.preservedAudioTransport, false);
  assert.equal(mic.audioTransport?.packetVersion, 1);
  assert.equal(mic.mediaGeneration, null);
  assert.equal(mic.mediaTicket, null);
});

test('direct media can outlive the publisher control socket without inventing lease authority', () => {
  const { mic, activeTickets } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 3,
    audioPacketVersion: 2,
    nowMs: 1_000,
  });

  assert.equal(mic.connected(), true);
  assert.equal(mic.mediaPath(), 'websocket');
  assert.deepEqual(mic.directMediaOffer(), { ticket: 'ticket-1' });
  assert.equal(mic.authorizeDirectMedia('wrong-ticket'), false);
  assert.equal(mic.authorizeDirectMedia('ticket-1'), true);

  const packet = encodeAudioPacket({
    source: 'mic',
    generation: 3,
    sequence: 0,
    firstSampleIndex: 0,
    pcm: Buffer.alloc(4),
  });
  assert.deepEqual(mic.receiveDirectMedia('wrong-ticket', packet, 1_100), []);
  assert.equal(mic.receiveDirectMedia('ticket-1', packet, 1_100).length, 1);

  activeTickets.add('ticket-1');
  assert.equal(mic.mediaPath(), 'webtransport');

  mic.detachPublisher(publisher);
  assert.equal(mic.controlConnected(), false);
  assert.equal(mic.connected(), true);
  assert.equal(mic.mediaPath(), 'webtransport');
  assert.equal(mic.mediaOwnerId, 'participant-alice');
  assert.equal(mic.mediaGeneration, 3);

  mic.clearMediaAuthority(2_000);
  assert.equal(mic.connected(), false);
  assert.equal(mic.mediaPath(), null);
  assert.equal(mic.sampleRate, null);
  assert.equal(mic.audioTransport, null);
  assert.equal(mic.authorizeDirectMedia('ticket-1'), false);
});

test('flow evidence is fenced to the canonical media owner and generation', () => {
  const { mic } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 4,
    audioPacketVersion: 2,
    nowMs: 1_000,
  });

  assert.equal(mic.flowObserved(), false);
  assert.equal(mic.frameAgeMs(2_000), null);
  assert.equal(mic.startupTimedOut(3_999), false);
  assert.equal(mic.startupTimedOut(4_000), true);

  mic.noteFrame(4_100);
  assert.equal(mic.flowObserved(), true);
  assert.equal(mic.frameAgeMs(4_450), 350);
  assert.equal(mic.streaming(4_999), true);
  assert.equal(mic.streaming(5_100), false);

  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(4, true), 4_200), true);
  assert.equal(mic.streaming(4_300), false, 'browser mute telemetry suppresses streaming');
  assert.equal(mic.uplinkHealthPayload(4_450)?.reportAgeMs, 250);

  const wrongGeneration = uplinkHealth(3, false);
  assert.equal(mic.noteUplinkHealth(publisher, wrongGeneration, 4_500), false);
  assert.equal(mic.uplinkHealthPayload(4_500)?.inputMuted, true);

  const freshCapture = socket('participant-alice');
  mic.bindPublisher({
    socket: freshCapture,
    sampleRate: 48_000,
    captureGeneration: 5,
    audioPacketVersion: 2,
    nowMs: 5_000,
  });
  assert.equal(mic.flowObserved(), false, 'new generation cannot inherit old frame evidence');
  assert.equal(mic.uplinkHealthPayload(5_000), null, 'new generation cannot inherit uplink health');
});
