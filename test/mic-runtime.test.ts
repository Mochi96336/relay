import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import { parseAudioUplinkHealth, type AudioUplinkHealth } from '../src/audio-uplink-health.js';
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

function uplinkHealth(
  captureGeneration: number,
  inputMuted = false,
  capturedSamples = 1_000,
): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration,
    capturedSamples,
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

test('product uplink health expires after the existing health authority window', () => {
  const { mic } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 6,
    audioPacketVersion: 2,
    nowMs: 100,
  });

  const degraded = uplinkHealth(6, false);
  degraded.transport.mediaRecoveryDegraded = true;
  assert.equal(mic.noteUplinkHealth(publisher, degraded, 200), true);
  assert.equal(mic.freshUplinkHealthPayload(4_200)?.reportAgeMs, 4_000);
  assert.equal(mic.freshUplinkHealthPayload(4_200)?.transport.mediaRecoveryDegraded, true);

  // Same-capture media authority can survive a short control reconnect, so the
  // diagnostic snapshot remains available. Product authority must not retain
  // that degraded verdict forever once health reporting stops.
  assert.equal(mic.detachPublisher(publisher), true);
  assert.equal(mic.uplinkHealthPayload(4_201)?.reportAgeMs, 4_001);
  assert.equal(mic.uplinkHealthPayload(4_201)?.transport.mediaRecoveryDegraded, true);
  assert.equal(mic.freshUplinkHealthPayload(4_201), null);
});

test('unmute health cannot reuse muted-period frame freshness as live Mic evidence', () => {
  const { mic } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 31,
    audioPacketVersion: 2,
    nowMs: 1_000,
  });

  mic.noteFrame(1_100);
  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(31, true, 2_000), 1_110), true);
  assert.equal(mic.streaming(1_120), false);

  // A muted track can keep producing zero PCM, so transport/frame freshness
  // may remain current while explicit track authority is fail-closed.
  mic.noteFrame(1_130);
  assert.equal(mic.streaming(1_140), false);

  // The browser reports the source cursor at the unmute boundary. Merely
  // clearing inputMuted must not resurrect the last muted zero frame as live
  // microphone evidence; a post-boundary frame has to arrive first.
  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(31, false, 3_000), 1_150), true);
  assert.equal(
    mic.streaming(1_151),
    false,
    'unmute requires new PCM beyond the browser-reported capture cursor',
  );

  const serialAtBoundary = mic.acceptedFrameSerial;
  mic.noteFrame(1_160, {
    generation: 31,
    firstSampleIndex: 2_500,
    pcm: Buffer.alloc(400 * 2),
  });
  assert.equal(
    mic.acceptedFrameSerial,
    serialAtBoundary + 1,
    'delayed muted PCM is still accepted intake evidence',
  );
  assert.equal(
    mic.streaming(1_161),
    false,
    'a delayed frame ending before the unmute cursor cannot clear the barrier',
  );

  mic.noteFrame(1_170, {
    generation: 31,
    firstSampleIndex: 3_000,
    pcm: Buffer.alloc(128 * 2),
  });
  assert.equal(
    mic.streaming(1_171),
    true,
    'the first accepted frame extending beyond the unmute cursor restores live flow',
  );
});

test('post-unmute media arriving before control health can satisfy the same sample barrier', () => {
  const { mic } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 32,
    audioPacketVersion: 2,
    nowMs: 2_000,
  });

  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(32, true, 2_000), 2_010), true);

  // The browser sent its unmute health at source cursor 3_000, but native
  // WebTransport can deliver later source PCM before that control message
  // reaches Relay. While the last received health still says muted, streaming
  // remains fail-closed.
  mic.noteFrame(2_020, {
    generation: 32,
    firstSampleIndex: 3_000,
    pcm: Buffer.alloc(128 * 2),
  });
  assert.equal(mic.streaming(2_021), false);

  // Once the delayed control health arrives, the already-accepted frame end
  // (3_128) proves PCM beyond the unmute cursor (3_000), so no second frame is
  // required merely because media/control took different network paths.
  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(32, false, 3_000), 2_030), true);
  assert.equal(mic.streaming(2_031), true);
});

test('same-generation uplink health cannot move capturedSamples backward', () => {
  const { mic } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 33,
    audioPacketVersion: 2,
    nowMs: 3_000,
  });

  assert.equal(
    mic.noteUplinkHealth(publisher, uplinkHealth(33, true, 4_000), 3_010),
    true,
  );
  assert.equal(mic.uplinkHealthPayload(3_011)?.capturedSamples, 4_000);

  // captureSampleCursor is monotonic inside one capture generation. Accepting
  // a lower cursor would let a malformed/stale unmute report shrink the
  // post-unmute source barrier and reclassify muted-period PCM as live.
  assert.equal(
    mic.noteUplinkHealth(publisher, uplinkHealth(33, false, 3_000), 3_020),
    false,
  );
  assert.equal(mic.uplinkHealthPayload(3_021)?.capturedSamples, 4_000);
  assert.equal(mic.uplinkHealthPayload(3_021)?.inputMuted, true);

  assert.equal(mic.detachPublisher(publisher), true);
  const reconnect = socket('participant-alice');
  const sameCapture = mic.bindPublisher({
    socket: reconnect,
    sampleRate: 48_000,
    captureGeneration: 33,
    audioPacketVersion: 2,
    nowMs: 3_030,
  });
  assert.equal(sameCapture.sameCapture, true);
  assert.equal(
    mic.noteUplinkHealth(reconnect, uplinkHealth(33, true, 3_500), 3_040),
    false,
    'same-capture control reconnect cannot reset the accepted cursor frontier',
  );
  assert.equal(
    mic.noteUplinkHealth(reconnect, uplinkHealth(33, true, 4_000), 3_050),
    true,
    'equal cursor remains a valid idempotent health observation',
  );

  const replacement = socket('participant-alice');
  const newCapture = mic.bindPublisher({
    socket: replacement,
    sampleRate: 48_000,
    captureGeneration: 34,
    audioPacketVersion: 2,
    nowMs: 3_060,
  });
  assert.equal(newCapture.captureReplaced, true);
  assert.equal(
    mic.noteUplinkHealth(replacement, uplinkHealth(34, false, 128), 3_070),
    true,
    'a genuinely new capture generation owns a new cursor origin',
  );
  assert.equal(mic.uplinkHealthPayload(3_071)?.capturedSamples, 128);
});

test('legacy v2 health without explicit mute state cannot authorize Mic live', () => {
  const { mic } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 34,
    audioPacketVersion: 2,
    nowMs: 4_000,
  });

  const rawLegacyHealth: any = uplinkHealth(34, false, 128);
  delete rawLegacyHealth.inputMuted;
  const legacyHealth = parseAudioUplinkHealth(rawLegacyHealth);
  assert.ok(legacyHealth, 'older health v1 without inputMuted remains parse-compatible');

  assert.equal(mic.noteUplinkHealth(publisher, legacyHealth, 4_010), true);
  mic.noteFrame(4_020, {
    generation: 34,
    firstSampleIndex: 0,
    pcm: Buffer.alloc(128 * 2),
  });
  assert.equal(
    mic.streaming(4_021),
    false,
    'fresh legacy health without explicit source mute evidence cannot authorize v2 live',
  );

  assert.equal(
    mic.noteUplinkHealth(publisher, uplinkHealth(34, false, 256), 4_030),
    true,
  );
  mic.noteFrame(4_040, {
    generation: 34,
    firstSampleIndex: 128,
    pcm: Buffer.alloc(128 * 2),
  });
  assert.equal(mic.streaming(4_041), true, 'explicit current unmuted health restores v2 live');
});

test('direct media cannot keep Mic live after source health authority expires', () => {
  const { mic, activeTickets } = runtime();
  const publisher = socket('participant-alice');
  mic.bindPublisher({
    socket: publisher,
    sampleRate: 48_000,
    captureGeneration: 35,
    audioPacketVersion: 2,
    nowMs: 100,
  });

  assert.equal(
    mic.noteUplinkHealth(publisher, uplinkHealth(35, false, 1_000), 200),
    true,
  );
  activeTickets.add('ticket-1');
  assert.equal(mic.mediaPath(), 'webtransport');

  // Direct media may bridge a short control outage while the last source-state
  // report is still authoritative.
  assert.equal(mic.detachPublisher(publisher), true);
  mic.noteFrame(4_090, {
    generation: 35,
    firstSampleIndex: 1_000,
    pcm: Buffer.alloc(128 * 2),
  });
  assert.equal(mic.freshUplinkHealthPayload(4_100)?.reportAgeMs, 3_900);
  assert.equal(mic.streaming(4_100), true);

  // Once health freshness expires, fresh PCM alone cannot prove that the
  // browser track is not OS-muted. Old inputMuted=false must fail closed.
  mic.noteFrame(4_202, {
    generation: 35,
    firstSampleIndex: 1_128,
    pcm: Buffer.alloc(128 * 2),
  });
  assert.equal(mic.freshUplinkHealthPayload(4_202), null);
  assert.equal(
    mic.streaming(4_202),
    false,
    'stale source-state telemetry cannot authorize live Mic indefinitely',
  );
});

test('v2 waits for current source health while legacy v1 remains PCM-only', () => {
  const { mic } = runtime();
  const v2 = socket('participant-alice');
  mic.bindPublisher({
    socket: v2,
    sampleRate: 48_000,
    captureGeneration: 36,
    audioPacketVersion: 2,
    nowMs: 5_000,
  });

  mic.noteFrame(5_100);
  assert.equal(
    mic.streaming(5_101),
    false,
    'v2 PCM cannot prove the browser source is unmuted before current health arrives',
  );
  assert.equal(
    mic.noteUplinkHealth(v2, uplinkHealth(36, false, 128), 5_110),
    true,
  );
  assert.equal(mic.streaming(5_111), true);

  const legacy = socket('participant-alice');
  mic.bindPublisher({
    socket: legacy,
    sampleRate: 48_000,
    captureGeneration: null,
    audioPacketVersion: 1,
    nowMs: 6_000,
  });
  mic.noteFrame(6_100);
  assert.equal(
    mic.streaming(6_101),
    true,
    'legacy v1 keeps its existing PCM-only streaming contract',
  );
});

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
  assert.equal(firstBind.captureReplaced, false);
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
  assert.equal(reconnectBind.captureReplaced, false);
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
  assert.equal(freshBind.captureReplaced, true);
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
  assert.equal(rebound.captureReplaced, true);
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
  assert.equal(same.captureReplaced, false);
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
  assert.equal(downgraded.captureReplaced, true);
  assert.equal(mic.audioTransport?.packetVersion, 1);
  assert.equal(mic.mediaGeneration, null);
  assert.equal(mic.mediaTicket, null);
});

test('cross-participant bind reports capture replacement even after old control detached', () => {
  const { mic } = runtime();
  const first = socket('participant-alice');
  mic.bindPublisher({
    socket: first,
    sampleRate: 48_000,
    captureGeneration: 20,
    audioPacketVersion: 2,
    nowMs: 100,
  });
  assert.equal(mic.detachPublisher(first), true);

  const takeover = socket('participant-bob');
  const rebound = mic.bindPublisher({
    socket: takeover,
    sampleRate: 48_000,
    captureGeneration: 1,
    audioPacketVersion: 2,
    nowMs: 200,
  });

  assert.equal(rebound.previousPublisher, null);
  assert.equal(rebound.sameParticipantReplacement, false);
  assert.equal(rebound.sameCapture, false);
  assert.equal(rebound.captureReplaced, true);
  assert.equal(rebound.preservedAudioTransport, false);
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
  assert.equal(
    mic.streaming(4_101),
    false,
    'v2 flow waits for current browser source-state health',
  );

  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(4, false), 4_110), true);
  assert.equal(mic.streaming(4_150), true);
  assert.equal(mic.streaming(5_100), false, 'stale PCM still fails independently of health');

  mic.noteFrame(5_200);
  assert.equal(mic.streaming(5_201), true);
  assert.equal(mic.noteUplinkHealth(publisher, uplinkHealth(4, true), 5_210), true);
  assert.equal(mic.streaming(5_220), false, 'browser mute telemetry suppresses streaming');
  assert.equal(mic.uplinkHealthPayload(5_460)?.reportAgeMs, 250);

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
