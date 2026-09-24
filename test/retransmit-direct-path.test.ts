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
      attempt: 0,
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

function capableRuntime({
  directConnected,
  directSendSucceeds = true,
  controlSendThrows = false,
}: {
  directConnected: boolean;
  directSendSucceeds?: boolean;
  controlSendThrows?: boolean;
}) {
  const direct: { ticket: string | null; bytes: Uint8Array }[] = [];
  const path = { directConnected, directSendOk: directSendSucceeds, controlSendOk: !controlSendThrows };
  const mic = new MicRuntime({
    audioTransportConfig: { ...DEFAULT_AUDIO_TRANSPORT_CONFIG, retransmitRequestDelayMs: 0 } as never,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    createDirectMediaTicket: () => 'ticket-direct',
    directMediaConnected: () => path.directConnected,
    offerDirectMedia: (ticket) => ({ ticket }) as never,
    sendDirectMedia: (ticket, bytes) => {
      if (!path.directSendOk) return false;
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
    send: (payload: string) => {
      if (!path.controlSendOk) throw new Error('control send failed');
      control.push(payload);
    },
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
  return { mic, direct, control, publisher, loseOne, path };
}

describe('Relay sends retransmission requests on every available path', () => {
  it('uses the direct media session and keeps the control socket as fallback', () => {
    const { mic, direct, control, loseOne } = capableRuntime({ directConnected: true });
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 1);

    assert.equal(direct.length, 1);
    assert.equal(direct[0]!.ticket, 'ticket-direct');
    assert.deepEqual(decodeRetransmitRequest(direct[0]!.bytes), { captureGeneration: 9, sequences: [1], attempt: 0 });
    assert.deepEqual(control.map((payload) => JSON.parse(payload)), [{
      type: 'audio-retransmit-request',
      version: 1,
      captureGeneration: 9,
      attempt: 0,
      sequences: [1],
    }]);
  });

  it('keeps a request that found no path and sends it when one returns', () => {
    const { mic, direct, control, publisher, loseOne, path } = capableRuntime({ directConnected: true });
    loseOne(10);
    // The hole was noticed with a path up; both vanish before the next tick.
    mic.flush(11);
    path.directConnected = false;
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    assert.equal(mic.serviceRetransmits(12, 300), 0);
    assert.equal(mic.retransmitStats()?.requestedPackets, 0);

    path.directConnected = true;
    assert.equal(mic.serviceRetransmits(20, 300), 1, 'the request was kept, not consumed');
    assert.deepEqual(decodeRetransmitRequest(direct[0]!.bytes)?.sequences, [1]);
    assert.deepEqual(control, []);
    assert.equal(mic.retransmitStats()?.requestedPackets, 1);
  });

  it('keeps asking over datagrams while control-socket health is delayed', () => {
    const { mic, direct, loseOne } = capableRuntime({ directConnected: true });
    // Health was last reported at 1 ms; a stalled TCP link has held the next
    // reports back for ten seconds while datagrams still flow.
    loseOne(10_000);
    assert.equal(mic.serviceRetransmits(10_002, 300), 1);
    assert.equal(direct.length, 1);
  });

  it('still records and later sends a hole noticed while both paths blink', () => {
    const { mic, direct, publisher, loseOne, path } = capableRuntime({ directConnected: true });
    mic.serviceRetransmits(5, 300);
    // A Wi-Fi roam: both request paths drop just as a packet is lost.
    path.directConnected = false;
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    mic.serviceRetransmits(8, 300);
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 0);
    mic.flush(100);
    assert.deepEqual(mic.flush(100).length, 0, 'the hole still holds inside the grace');

    path.directConnected = true;
    assert.equal(mic.serviceRetransmits(150, 300), 1);
    assert.deepEqual(decodeRetransmitRequest(direct[0]!.bytes)?.sequences, [1]);
  });

  it('treats holes as ordinary loss once no path has been seen for a while', () => {
    const { mic, direct, publisher, loseOne, path } = capableRuntime({ directConnected: true });
    mic.serviceRetransmits(5, 300);
    path.directConnected = false;
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    mic.serviceRetransmits(600, 300);
    loseOne(610);
    assert.equal(mic.serviceRetransmits(612, 300), 0);
    path.directConnected = true;
    assert.equal(mic.serviceRetransmits(620, 300), 0, 'a hole from the outage was never recorded');
    assert.deepEqual(direct, []);
  });

  it('marks only the batches that went out as asked for', () => {
    const { mic, direct, publisher, loseOne, path } = capableRuntime({ directConnected: true });
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 1);

    // By 170 ms the retry for 1 is due, and 3 has just gone missing: two
    // datagram batches (attempt 1, then attempt 0). The second send fails.
    mic.receiveDirectMedia('ticket-direct', encodeAudioPacket({
      source: 'mic', generation: 9, sequence: 4, firstSampleIndex: 4 * 480, pcm: Buffer.alloc(960),
    }), 170);
    mic.flush(170);
    let sends = 0;
    Object.defineProperty(path, 'directSendOk', {
      get: () => (sends += 1) !== 2,
      configurable: true,
    });
    assert.equal(mic.serviceRetransmits(170, 300), 1, 'only the retry went out');
    assert.deepEqual(
      direct.map(({ bytes }) => decodeRetransmitRequest(bytes)).map((r) => [r!.attempt, r!.sequences]),
      [[0, [1]], [1, [1]]],
    );
    assert.equal(mic.retransmitStats()?.requestedPackets, 1, 'hole 3 was not asked for yet');

    // The failed batch stayed queued and goes out on the next tick.
    Object.defineProperty(path, 'directSendOk', { value: true, writable: true, configurable: true });
    assert.equal(mic.serviceRetransmits(180, 300), 1);
    assert.deepEqual(decodeRetransmitRequest(direct[2]!.bytes), { captureGeneration: 9, sequences: [3], attempt: 0 });
    assert.equal(mic.retransmitStats()?.requestedPackets, 2);
  });

  it('retries with a higher attempt number when no repeat arrives', () => {
    const { mic, direct, control, loseOne } = capableRuntime({ directConnected: true });
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 1);
    mic.flush(170);
    assert.equal(mic.serviceRetransmits(170, 300), 1);
    assert.deepEqual(direct.map(({ bytes }) => decodeRetransmitRequest(bytes)?.attempt), [0, 1]);
    assert.deepEqual(control.map((payload) => JSON.parse(payload).attempt), [0, 1]);
    assert.equal(mic.retransmitStats()?.retriedPackets, 1);
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

  it('keeps a request promoted before the service tick finds no path, and sends it once one returns', () => {
    const { mic, control, publisher, loseOne } = capableRuntime({ directConnected: false });

    // Media proves a hole while the receiver still has its constructor-default
    // request capability. The control path disappears before MicRuntime gets its
    // next chance to reconcile path/capability state.
    loseOne(10);
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;

    assert.equal(mic.serviceRetransmits(12, 300), 0);
    assert.equal(mic.retransmitStats()?.requestedPackets, 0, 'nothing has left Relay');

    // The path comes back: the request that was kept goes out, instead of the
    // hole waiting to be proven again by later media.
    (publisher as { readyState: number }).readyState = WebSocket.OPEN;
    assert.equal(mic.serviceRetransmits(13, 300), 1);
    assert.deepEqual(control.map((payload) => JSON.parse(payload).sequences), [[1]]);
    assert.equal(mic.retransmitStats()?.requestedPackets, 1);
  });

  it('keeps a request whose every send fails and sends it when a send succeeds', () => {
    const { mic, direct, loseOne, path } = capableRuntime({
      directConnected: true,
      directSendSucceeds: false,
      controlSendThrows: true,
    });
    loseOne(10);

    assert.equal(mic.serviceRetransmits(12, 300), 0);
    assert.equal(
      mic.retransmitStats()?.requestedPackets,
      0,
      'a repeat that reached no path was never actually requested',
    );
    assert.equal(mic.serviceRetransmits(13, 300), 0);

    path.directSendOk = true;
    assert.equal(mic.serviceRetransmits(14, 300), 1);
    assert.deepEqual(decodeRetransmitRequest(direct[0]!.bytes)?.sequences, [1]);
    assert.equal(mic.retransmitStats()?.requestedPackets, 1);
  });

  it('never asks when no path can carry a request, but still waits for a late packet', () => {
    const { mic, direct, control, publisher, loseOne } = capableRuntime({ directConnected: false });
    (publisher as { readyState: number }).readyState = WebSocket.CLOSED;
    mic.serviceRetransmits(5, 300);
    loseOne(10);
    assert.equal(mic.serviceRetransmits(12, 300), 0);
    assert.deepEqual(direct, []);
    assert.deepEqual(control, []);
    assert.equal(mic.retransmitStats()?.requestedPackets, 0, 'no request is recorded as sent');
    const pastReorderDeadline = 10 + DEFAULT_AUDIO_TRANSPORT_CONFIG.reorderDeadlineMs + 2;
    assert.deepEqual(mic.flush(pastReorderDeadline), [], 'the mix can afford to wait');
    // Once the mix runs short, the hole is released as ordinary loss.
    mic.serviceRetransmits(pastReorderDeadline, 40);
    assert.deepEqual(mic.flush(pastReorderDeadline).map((frame) => frame.firstSampleIndex), [960]);
  });
});
