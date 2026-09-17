import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { AudioSession } from '../src/audio-session.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

const SAMPLE_RATE = 48_000;
const PACKET_SAMPLES = 480; // 10 ms; still fits the production WT datagram ceiling.

function packet(sequence: number, firstSampleIndex: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation: 11,
    sequence,
    firstSampleIndex,
    pcm: Buffer.alloc(PACKET_SAMPLES * 2),
  });
}

test('WebTransport to WebSocket fallback preserves the missing PCM hole in AudioSession', () => {
  const activeTickets = new Set<string>();
  const mic = new MicRuntime({
    audioTransportConfig: {
      reorderWindowPackets: 0,
      reorderDeadlineMs: 0,
      maxForwardJumpPackets: 32,
    },
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    uplinkHealthTimeoutMs: 60_000,
    createDirectMediaTicket: () => 'fallback-hole-ticket',
    directMediaConnected: (ticket) => Boolean(ticket && activeTickets.has(ticket)),
    offerDirectMedia: (ticket) => ({ ticket }),
  });
  const session = new AudioSession({
    sampleRate: SAMPLE_RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
  });
  session.setMicGainDb(0);
  session.start(0);
  session.setMicExpected(true);

  const socket = {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId: 'participant-fallback-hole',
    send() {},
    close() {},
    terminate() {},
  } as unknown as RelaySocket;

  mic.bindPublisher({
    socket,
    sampleRate: SAMPLE_RATE,
    captureGeneration: 11,
    audioPacketVersion: 2,
    nowMs: 0,
  });
  const ticket = mic.mediaTicket!;
  activeTickets.add(ticket);

  const firstFrames = mic.receiveDirectMedia(ticket, packet(0, 0), 100);
  assert.equal(firstFrames.length, 1);
  const firstIngest = session.ingestMic(firstFrames[0], mic.sampleRate, 100);
  assert.equal(firstIngest.start, 0);
  assert.equal(firstIngest.samples.length, PACKET_SAMPLES);
  mic.noteFrame(100);
  assert.equal(session.micTotalSamples, PACKET_SAMPLES);
  assert.equal(session.health().micGapMs, 0);
  assert.equal(mic.mediaPath(), 'webtransport');

  // The next 10 ms capture packet (sequence 1, samples 480..959) disappears.
  // Demotion changes only the transport path; it must not rewrite capture
  // identity or invent replacement PCM for the missing source interval.
  activeTickets.delete(ticket);
  assert.equal(mic.mediaPath(), 'websocket');

  const recoveredFrames = mic.receivePublisher(
    socket,
    packet(2, PACKET_SAMPLES * 2),
    300,
  );
  assert.equal(recoveredFrames.length, 1);
  assert.equal(recoveredFrames[0].generation, 11);
  assert.equal(recoveredFrames[0].firstSampleIndex, PACKET_SAMPLES * 2);

  const recoveredIngest = session.ingestMic(recoveredFrames[0], mic.sampleRate, 300);
  assert.equal(recoveredIngest.start, PACKET_SAMPLES * 2);
  assert.equal(recoveredIngest.samples.length, PACKET_SAMPLES);
  mic.noteFrame(300);

  assert.equal(session.micTotalSamples, PACKET_SAMPLES * 3);
  assert.equal(session.health().micGapMs, 10, 'the missing WT packet remains a 10 ms session-timeline hole');
  assert.equal(mic.receiverStats()?.lostPackets, 1);
  assert.equal(mic.receiverStats()?.emittedPackets, 2);
  assert.equal(mic.mediaGeneration, 11, 'fallback does not rebuild capture generation');
  assert.equal(mic.mediaOwnerId, 'participant-fallback-hole');
  assert.equal(mic.frameAgeMs(300), 0, 'server-authoritative PCM progress resumes only after WS acceptance');

  mic.clearMediaAuthority(300);
});
