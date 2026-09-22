import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { MicCaptureRecoveryWatchdog } from '../public/mic-capture-recovery.js';
import { PublisherCommandLiveness } from '../public/publisher-command-liveness.js';
import { encodeAudioPacket } from '../src/audio-packet.js';
import { AudioSession } from '../src/audio-session.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

const SAMPLE_RATE = 48_000;

function fakeSocket(participantId = 'participant-proof') {
  const sent: string[] = [];
  const socket = {
    readyState: WebSocket.OPEN,
    role: 'publisher',
    isAlive: true,
    participantId,
    send(data: unknown) {
      sent.push(String(data));
    },
    close() {},
    terminate() {},
  } as unknown as RelaySocket;
  return { socket, sent };
}

function health(
  captureGeneration: number,
  capturedSamples: number,
  {
    path = 'webtransport',
    submitted = 0,
    healthRequestId,
  }: {
    path?: 'websocket' | 'webtransport';
    submitted?: number;
    healthRequestId?: number;
  } = {},
): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration,
    ...(healthRequestId === undefined ? {} : { healthRequestId }),
    capturedSamples,
    inputGapSamples: 0,
    inputGapActive: false,
    inputMuted: false,
    capture: null,
    captureLevel: null,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path,
      maxPacketBytes: path === 'webtransport' ? 1000 : null,
      minWebTransportMaxPacketBytes: path === 'webtransport' ? 1200 : null,
      maxWebTransportMaxPacketBytes: path === 'webtransport' ? 1200 : null,
      datagramPacketBytesCeiling: path === 'webtransport' ? 1000 : null,
      datagramQueuePackets: path === 'webtransport' ? 4 : null,
      webTransportAttempts: path === 'webtransport' ? 1 : 0,
      webTransportConnections: path === 'webtransport' ? 1 : 0,
      webTransportDemotions: path === 'websocket' ? 1 : 0,
      webTransportPacketsSubmitted: submitted,
      webTransportCongestedRejects: 0,
      webTransportPacketTooLargeRejects: 0,
      webTransportSendFailures: 0,
      webSocketPacketsSent: path === 'websocket' ? submitted : 0,
      webSocketCongestedRejects: 0,
      webSocketDisconnectedRejects: 0,
      webSocketSendFailures: 0,
    },
  };
}

function packet(
  generation: number,
  sequence: number,
  firstSampleIndex: number,
  sampleCount = 2,
) {
  return encodeAudioPacket({
    source: 'mic',
    generation,
    sequence,
    firstSampleIndex,
    pcm: Buffer.alloc(sampleCount * 2),
  });
}

function runtime({ streamLiveMs = 1_000 } = {}) {
  let ticketSequence = 0;
  const activeTickets = new Set<string>();
  const mic = new MicRuntime({
    audioTransportConfig: {
      // Loss is finalized immediately in these proof cases so no wall-clock
      // sleeps are needed to expose the real capture-timeline hole.
      reorderWindowPackets: 0,
      reorderDeadlineMs: 0,
      maxForwardJumpPackets: 32,
    },
    firstFrameTimeoutMs: 3_000,
    streamLiveMs,
    uplinkHealthTimeoutMs: 60_000,
    createDirectMediaTicket: () => `proof-ticket-${++ticketSequence}`,
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
  return { mic, session, activeTickets };
}

function bind(
  mic: MicRuntime,
  socket: RelaySocket,
  captureGeneration: number,
  nowMs = 0,
  sampleRate = SAMPLE_RATE,
) {
  return mic.bindPublisher({
    socket,
    sampleRate,
    captureGeneration,
    audioPacketVersion: 2,
    nowMs,
  });
}

function acceptServerFrames(
  mic: MicRuntime,
  session: AudioSession,
  frames: ReturnType<MicRuntime['receivePublisher']>,
  nowMs: number,
) {
  for (const frame of frames) {
    const ingested = session.ingestMic(frame, mic.sampleRate, nowMs);
    if (ingested.samples.length > 0) mic.noteFrame(nowMs, frame);
  }
  return frames;
}

function captureSnapshot(nowMs: number, contextTime: number, sampleCursor: number) {
  return {
    nowMs,
    contextTime,
    sampleCursor,
    contextState: 'running',
    visible: true,
  };
}

test('control ACK and local capture progress cannot freshen a stale server PCM frontier', () => {
  const { mic, session, activeTickets } = runtime({ streamLiveMs: 500 });
  const publisher = fakeSocket();
  bind(mic, publisher.socket, 7, 0);
  const ticket = mic.mediaTicket!;
  activeTickets.add(ticket);

  const initial = acceptServerFrames(
    mic,
    session,
    mic.receiveDirectMedia(ticket, packet(7, 0, 0), 100),
    100,
  );
  assert.equal(initial.length, 1);
  assert.equal(mic.frameAgeMs(100), 0);

  const capture = new MicCaptureRecoveryWatchdog({ stallAfterMs: 500 });
  capture.start(captureSnapshot(100, 1, 2));
  assert.equal(
    capture.observe(captureSnapshot(200, 1.1, 130), { freshPcm: true }).recovered,
    true,
  );

  const command = new PublisherCommandLiveness();
  command.begin(7, 100);

  // The browser capture clock keeps moving and its application-level control
  // report still makes a full round trip. No media packet is delivered here.
  const local = capture.observe(
    captureSnapshot(2_000, 2.9, 96_002),
    { freshPcm: true },
  );
  assert.equal(local.rebuild, false);
  const healthRequestId = command.beginHealthRequest(2_000);
  assert.notEqual(healthRequestId, null);
  assert.equal(mic.noteUplinkHealth(
    publisher.socket,
    health(7, 96_002, { submitted: 100, healthRequestId: healthRequestId! }),
    2_000,
  ), true);
  const ack = JSON.parse(publisher.sent.at(-1)!);
  assert.equal(ack.healthRequestId, healthRequestId);
  assert.equal(command.noteAck(ack.captureGeneration, ack.healthRequestId, 2_000), true);

  assert.equal(command.status(2_100).fresh, true, 'control round trip remains fresh');
  assert.equal(mic.uplinkHealthPayload(2_100)?.capturedSamples, 96_002, 'local capture keeps advancing');
  assert.equal(mic.receiverStats()?.emittedPackets, 1, 'server receiver accepted no new PCM');
  assert.equal(mic.frameAgeMs(2_100), 2_000, 'server media age advances independently of health ACKs');
  assert.equal(mic.streaming(2_100), false, 'stale server PCM is not made streaming by fresh control');

  mic.clearMediaAuthority(2_100);
});

test('receiver-emitted PCM cannot renew liveness without AudioSession sample progress', () => {
  const { mic, session } = runtime({ streamLiveMs: 500 });
  const publisher = fakeSocket('participant-session-acceptance');
  bind(mic, publisher.socket, 8, 0, 96_000);

  const first = acceptServerFrames(
    mic,
    session,
    mic.receivePublisher(publisher.socket, packet(8, 0, 0, 1), 100),
    100,
  );
  assert.equal(first.length, 1);
  assert.equal(mic.frameAgeMs(100), 0);

  // At 96 kHz -> 48 kHz, absolute target sample 1 lives at source index 2.
  // A valid one-sample packet containing source index 1 advances the transport
  // receiver but contributes no target-rate PCM yet.
  const betweenTargets = mic.receivePublisher(
    publisher.socket,
    packet(8, 1, 1, 1),
    200,
  );
  assert.equal(betweenTargets.length, 1, 'transport accepts the monotonic source frame');
  assert.equal(mic.receiverStats()?.emittedPackets, 2);
  const betweenIngest = session.ingestMic(betweenTargets[0], mic.sampleRate, 200);
  assert.equal(
    betweenIngest.samples.length,
    0,
    'a source sample between target instants contributes no new session PCM',
  );
  if (betweenIngest.samples.length > 0) mic.noteFrame(200);

  assert.equal(
    mic.frameAgeMs(200),
    100,
    'receiver emission alone must not renew server PCM freshness',
  );

  // Source index 2 is the next exact 48 kHz target instant, so real AudioSession
  // progress resumes liveness.
  const target = acceptServerFrames(
    mic,
    session,
    mic.receivePublisher(publisher.socket, packet(8, 2, 2, 1), 300),
    300,
  );
  assert.equal(target.length, 1);
  assert.equal(mic.frameAgeMs(300), 0);

  // And the same rule repeats for source index 3: accepted transport without a
  // new target-rate sample does not keep the server media frontier fresh.
  const secondBetweenTargets = mic.receivePublisher(
    publisher.socket,
    packet(8, 3, 3, 1),
    400,
  );
  assert.equal(secondBetweenTargets.length, 1);
  assert.equal(mic.receiverStats()?.emittedPackets, 4);
  const secondBetweenIngest = session.ingestMic(
    secondBetweenTargets[0],
    mic.sampleRate,
    400,
  );
  assert.equal(secondBetweenIngest.samples.length, 0);
  if (secondBetweenIngest.samples.length > 0) mic.noteFrame(400);

  assert.equal(mic.frameAgeMs(400), 100);
  assert.equal(mic.frameAgeMs(900), 600);
  assert.equal(mic.streaming(900), false, 'post-session freshness expires without novel PCM contribution');

  mic.clearMediaAuthority(900);
});

test('manual WebTransport to WebSocket recovery preserves capture identity and leaves the loss hole', () => {
  const { mic, session, activeTickets } = runtime();
  const publisher = fakeSocket('participant-fallback');
  bind(mic, publisher.socket, 11, 0);
  const transport = mic.audioTransport;
  const ticket = mic.mediaTicket!;
  activeTickets.add(ticket);

  const first = acceptServerFrames(
    mic,
    session,
    mic.receiveDirectMedia(ticket, packet(11, 0, 0), 100),
    100,
  );
  assert.deepEqual(
    first.map((frame) => ({ generation: frame.generation, firstSampleIndex: frame.firstSampleIndex })),
    [{ generation: 11, firstSampleIndex: 0 }],
  );
  assert.equal(mic.mediaPath(), 'webtransport');

  // sequence=1 / firstSampleIndex=2 is captured but disappears before Relay
  // receives it. The capture clock still advances to the next packet.
  activeTickets.delete(ticket);
  assert.equal(mic.mediaPath(), 'websocket');

  const recovered = acceptServerFrames(
    mic,
    session,
    mic.receivePublisher(publisher.socket, packet(11, 2, 4), 300),
    300,
  );
  assert.deepEqual(
    recovered.map((frame) => ({
      generation: frame.generation,
      firstSampleIndex: frame.firstSampleIndex,
      sampleCount: frame.pcm.byteLength / 2,
    })),
    [{ generation: 11, firstSampleIndex: 4, sampleCount: 2 }],
    'fallback resumes at the real capture position instead of backfilling the missing samples',
  );
  assert.equal(mic.audioTransport, transport, 'transport switch must not replace capture receiver authority');
  assert.equal(mic.mediaGeneration, 11);
  assert.equal(mic.mediaOwnerId, 'participant-fallback');
  assert.equal(mic.receiverStats()?.lostPackets, 1);
  assert.equal(mic.receiverStats()?.emittedPackets, 2);
  assert.equal(mic.frameAgeMs(300), 0, 'current-generation server PCM progress resumes on WebSocket');

  mic.clearMediaAuthority(300);
});

test('late generation-A media, health and ACK evidence cannot revive generation B', () => {
  const { mic, session, activeTickets } = runtime();
  const generationA = fakeSocket('participant-generation');
  bind(mic, generationA.socket, 20, 0);
  const ticketA = mic.mediaTicket!;
  activeTickets.add(ticketA);

  const aFrames = acceptServerFrames(
    mic,
    session,
    mic.receiveDirectMedia(ticketA, packet(20, 0, 0), 100),
    100,
  );
  assert.equal(aFrames.length, 1);
  assert.equal(mic.flowObserved(), true);

  const generationB = fakeSocket('participant-generation');
  bind(mic, generationB.socket, 21, 200);
  const ticketB = mic.mediaTicket!;
  assert.notEqual(ticketB, ticketA);

  const commandB = new PublisherCommandLiveness();
  commandB.begin(21, 200);
  const requestB = commandB.beginHealthRequest(225);
  assert.notEqual(requestB, null);

  assert.equal(mic.flowObserved(), false, 'B starts without inheriting A media freshness');
  assert.equal(mic.frameAgeMs(200), null);
  assert.equal(mic.authorizeDirectMedia(ticketA), false, 'A direct-media capability is retired');
  assert.deepEqual(mic.receiveDirectMedia(ticketA, packet(20, 1, 2), 250), []);
  assert.deepEqual(mic.receivePublisher(generationA.socket, packet(20, 1, 2), 250), []);
  assert.equal(mic.noteUplinkHealth(generationA.socket, health(20, 4), 250), false);
  assert.equal(commandB.noteAck(20, requestB!, 250), false, 'A ACK cannot satisfy B command liveness');

  assert.equal(commandB.status(250).fresh, false);
  assert.equal(mic.mediaGeneration, 21);
  assert.equal(mic.mediaTicket, ticketB);
  assert.equal(mic.flowObserved(), false, 'late A evidence cannot cancel B media recovery');

  mic.clearMediaAuthority(250);
});

test('fresh PCM cannot revive stale control authority', () => {
  const { mic, session } = runtime({ streamLiveMs: 500 });
  const publisher = fakeSocket('participant-control-independent');
  bind(mic, publisher.socket, 30, 0);

  const command = new PublisherCommandLiveness();
  command.begin(30, 0);
  const commandRequestId = command.beginHealthRequest(100);
  assert.notEqual(commandRequestId, null);
  assert.equal(command.noteAck(30, commandRequestId!, 100), true);
  assert.equal(command.status(200).fresh, true);

  acceptServerFrames(mic, session, mic.receivePublisher(publisher.socket, packet(30, 0, 0), 100), 100);

  const staleAt = 3_100;
  assert.equal(command.status(staleAt).fresh, false, '#304 command authority expires without ACK progress');
  assert.equal(command.status(staleAt).reconnect, false);

  // Source-state health is a separate v2 authority from command ACK liveness.
  // Keep it current so this proof isolates stale command authority only.
  assert.equal(mic.noteUplinkHealth(publisher.socket, health(30, 4), staleAt - 10), true);

  const freshPcm = acceptServerFrames(
    mic,
    session,
    mic.receivePublisher(publisher.socket, packet(30, 1, 2), staleAt),
    staleAt,
  );
  assert.equal(freshPcm.length, 1);
  assert.equal(mic.frameAgeMs(staleAt), 0);
  assert.equal(mic.streaming(staleAt), true, 'server media can still be fresh while control authority is stale');
  assert.equal(command.status(staleAt).fresh, false, 'PCM progress is not control ACK authority');

  mic.clearMediaAuthority(staleAt);
});

test('capture sample-clock failure is detectable before media transport freshness expires', () => {
  const { mic, session } = runtime({ streamLiveMs: 500 });
  const publisher = fakeSocket('participant-capture-independent');
  bind(mic, publisher.socket, 40, 0);
  acceptServerFrames(mic, session, mic.receivePublisher(publisher.socket, packet(40, 0, 0), 0), 0);
  assert.equal(
    mic.noteUplinkHealth(publisher.socket, health(40, 2), 0),
    true,
    'source-state health stays authoritative while the local capture clock stalls',
  );

  const command = new PublisherCommandLiveness();
  command.begin(40, 0);
  const commandRequestId = command.beginHealthRequest(100);
  assert.notEqual(commandRequestId, null);
  assert.equal(command.noteAck(40, commandRequestId!, 100), true);

  const capture = new MicCaptureRecoveryWatchdog({ stallAfterMs: 100 });
  capture.start(captureSnapshot(0, 1, 2));
  const stalledCapture = capture.observe(captureSnapshot(120, 1.12, 2));

  assert.equal(stalledCapture.contextAdvanced, true);
  assert.equal(stalledCapture.rebuild, true, 'existing sample-cursor watchdog owns capture-graph stalls');
  assert.equal(command.status(120).fresh, true, 'control can still be healthy during capture failure');
  assert.equal(mic.frameAgeMs(120), 120);
  assert.equal(mic.streaming(120), true, 'server media freshness has not yet independently expired');

  mic.clearMediaAuthority(120);
});
