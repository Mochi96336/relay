import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';
import {
  decodeRetransmitRequest,
  encodeRetransmitRequest,
} from '../shared/retransmit-request.js';

describe('retransmission request datagram codec', () => {
  it('round-trips a request', () => {
    const bytes = encodeRetransmitRequest(0xfeed_beef, [1, 2, 0xffff_ffff]);
    assert.deepEqual(decodeRetransmitRequest(bytes), {
      captureGeneration: 0xfeed_beef,
      sequences: [1, 2, 0xffff_ffff],
    });
  });

  it('ignores media packets and malformed requests sharing the datagram path', () => {
    const media = encodeAudioPacket({
      source: 'mic',
      generation: 1,
      sequence: 1,
      firstSampleIndex: 0,
      pcm: Buffer.alloc(8),
    });
    assert.equal(decodeRetransmitRequest(new Uint8Array(media)), null);
    const truncated = encodeRetransmitRequest(1, [1, 2]).slice(0, 12);
    assert.equal(decodeRetransmitRequest(truncated), null);
    assert.equal(decodeRetransmitRequest('not bytes'), null);
    assert.throws(() => encodeRetransmitRequest(1, []), /non-empty/);
  });
});

function health(generation: number): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration: generation,
    capturedSamples: 1_000,
    inputGapSamples: 0,
    inputGapActive: false,
    inputMuted: false,
    capture: null,
    captureLevel: null,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path: 'webtransport',
      maxPacketBytes: 1000,
      minWebTransportMaxPacketBytes: 1200,
      maxWebTransportMaxPacketBytes: 1200,
      datagramPacketBytesCeiling: 1000,
      datagramQueuePackets: 4,
      webTransportAttempts: 1,
      webTransportConnections: 1,
      webTransportDemotions: 0,
      webTransportPacketsSubmitted: 0,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
      retransmitBufferPackets: 128,
    },
  };
}

function capableRuntime({ directConnected }: { directConnected: boolean }) {
  const direct: { ticket: string | null; bytes: Uint8Array }[] = [];
  const mic = new MicRuntime({
    audioTransportConfig: { ...DEFAULT_AUDIO_TRANSPORT_CONFIG, retransmitRequestDelayMs: 0 } as never,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    createDirectMediaTicket: () => 'ticket-direct',
    directMediaConnected: () => directConnected,
    offerDirectMedia: (ticket) => ({ ticket }) as never,
    sendDirectMedia: (ticket, bytes) => {
      direct.push({ ticket, bytes });
      return true;
    },
  });
  const control: string[] = [];
  const publisher = {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId: 'participant-direct',
    send: (payload: string) => control.push(payload),
  } as unknown as RelaySocket & { readyState: number };
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 9,
    audioPacketVersion: 2,
    nowMs: 0,
  });
  assert.equal(mic.noteUplinkHealth(publisher, health(9), 1), true);
  control.length = 0;
  const packet = (sequence: number) => encodeAudioPacket({
    source: 'mic',
    generation: 9,
    sequence,
    firstSampleIndex: sequence * 480,
    pcm: Buffer.alloc(960),
  });
  const loseOne = (nowMs: number) => {
    mic.receiveDirectMedia('ticket-direct', packet(0), nowMs);
    mic.receiveDirectMedia('ticket-direct', packet(2), nowMs + 1);
  };
  return { mic, direct, control, publisher, loseOne };
}

describe('Relay sends retransmission requests on every available path', () => {
  it('uses the direct media session and keeps the control socket as fallback', () => {
    const { mic, direct, control, loseOne } = capableRuntime({ directConnected: true });
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 1);

    assert.equal(direct.length, 1);
    assert.equal(direct[0]!.ticket, 'ticket-direct');
    assert.deepEqual(decodeRetransmitRequest(direct[0]!.bytes), { captureGeneration: 9, sequences: [1] });
    assert.deepEqual(control.map((payload) => JSON.parse(payload)), [{
      type: 'audio-retransmit-request',
      version: 1,
      captureGeneration: 9,
      sequences: [1],
    }]);
  });

  it('still asks over the direct session while the control socket reconnects', () => {
    const { mic, direct, control, publisher, loseOne } = capableRuntime({ directConnected: true });
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    mic.serviceRetransmits(5, 300);
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 1);
    assert.equal(direct.length, 1);
    assert.deepEqual(control, []);
  });

  it('neither asks nor holds when no path can carry a request', () => {
    const { mic, direct, control, publisher, loseOne } = capableRuntime({ directConnected: false });
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    mic.serviceRetransmits(5, 300);
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 0);
    assert.deepEqual(direct, []);
    assert.deepEqual(control, []);
    assert.equal(mic.retransmitStats()?.requestedPackets, 0, 'no request is recorded as sent');
    // The hole is released at the ordinary reorder deadline, not held for a repeat.
    assert.deepEqual(mic.flush(10 + DEFAULT_AUDIO_TRANSPORT_CONFIG.reorderDeadlineMs + 2).map((frame) => frame.firstSampleIndex), [960]);
  });
});
