import assert from 'node:assert/strict';
import test from 'node:test';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { AudioSession } from '../src/audio-session.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';

const moduleUrl = new URL('../public/audio-transport.js', import.meta.url);
const SAMPLE_RATE = 48_000;
const PACKET_SAMPLES = 480;
const GENERATION = 7;
const PARTICIPANT_ID = 'participant-terminal-proof';

function packet(sequence: number, firstSampleIndex: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation: GENERATION,
    sequence,
    firstSampleIndex,
    pcm: Buffer.alloc(PACKET_SAMPLES * 2),
  });
}

function health(capturedSamples: number): AudioUplinkHealth & { type: 'audio-uplink-health' } {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: GENERATION,
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

class BrowserSocket {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<(event: { data: string }) => void>>();

  constructor(private readonly onSend: (payload: unknown) => void) {}

  send(payload: unknown) {
    this.onSend(payload);
  }

  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  emitText(data: string) {
    for (const listener of this.listeners.get('message') ?? []) listener({ data });
  }
}

class SocketBridge {
  nowMs = 0;
  dropPcm = false;
  readonly browserSocket: BrowserSocket;
  readonly serverSocket: RelaySocket;
  readonly acceptedFrames: Array<{ generation: number; firstSampleIndex: number; sampleCount: number }> = [];
  private readonly pendingServerMessages: string[] = [];

  constructor(
    private readonly mic: MicRuntime,
    private readonly session: AudioSession,
  ) {
    this.browserSocket = new BrowserSocket((payload) => this.receiveFromBrowser(payload));
    this.serverSocket = {
      readyState: WebSocket.OPEN,
      role: 'publisher',
      isAlive: true,
      participantId: PARTICIPANT_ID,
      send: (payload: unknown) => {
        this.pendingServerMessages.push(String(payload));
      },
      close() {},
      terminate() {},
    } as unknown as RelaySocket;
  }

  bindServer(nowMs: number) {
    this.nowMs = nowMs;
    return this.mic.bindPublisher({
      socket: this.serverSocket,
      sampleRate: SAMPLE_RATE,
      captureGeneration: GENERATION,
      audioPacketVersion: 2,
      nowMs,
    });
  }

  detachServer() {
    return this.mic.detachPublisher(this.serverSocket);
  }

  private receiveFromBrowser(payload: unknown) {
    if (typeof payload === 'string') {
      const message = JSON.parse(payload);
      if (message?.type !== 'audio-uplink-health') return;
      const { type: _type, ...uplinkHealth } = message;
      this.mic.noteUplinkHealth(
        this.serverSocket,
        uplinkHealth as AudioUplinkHealth,
        this.nowMs,
      );
      return;
    }
    if (this.dropPcm) return;
    const frames = this.mic.receivePublisher(
      this.serverSocket,
      Buffer.from(payload as Uint8Array),
      this.nowMs,
    );
    for (const frame of frames) {
      const ingested = this.session.ingestMic(frame, this.mic.sampleRate, this.nowMs);
      if (ingested.samples.length < 1) continue;
      assert.ok(
        typeof frame.generation === 'number' && typeof frame.firstSampleIndex === 'number',
        'accepted v2 proof frames must retain generation and sample frontier identity',
      );
      this.mic.noteFrame(this.nowMs);
      this.acceptedFrames.push({
        generation: frame.generation,
        firstSampleIndex: frame.firstSampleIndex,
        sampleCount: frame.pcm.byteLength / 2,
      });
    }
  }

  flushServerMessages() {
    const messages = this.pendingServerMessages.splice(0);
    for (const message of messages) this.browserSocket.emitText(message);
    return messages.map((message) => JSON.parse(message));
  }
}

function runtime() {
  const mic = new MicRuntime({
    audioTransportConfig: {
      reorderWindowPackets: 0,
      reorderDeadlineMs: 0,
      maxForwardJumpPackets: 32,
    },
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    uplinkHealthTimeoutMs: 60_000,
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
  return { mic, session };
}

test('same-generation websocket replacement is bounded, then spontaneous PCM can clear only the degraded verdict', async () => {
  const { mic, session } = runtime();
  const first = new SocketBridge(mic, session);
  const firstBind = first.bindServer(0);
  assert.equal(firstBind.preservedAudioTransport, false);

  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport();
  transport.bind(first.browserSocket);

  const sendHealth = (bridge: SocketBridge, capturedSamples: number) => {
    assert.equal(transport.sendControlJson(health(capturedSamples)).sent, true);
    const messages = bridge.flushServerMessages();
    const ack = messages.find((message) => message?.type === 'audio-uplink-health-ack');
    assert.ok(ack, 'real MicRuntime must ACK current-generation health on the active socket');
    return ack;
  };

  first.nowMs = 100;
  assert.equal(transport.send(packet(0, 0)).sent, true);
  assert.equal(mic.acceptedFrameSerial, 1);
  const baseline = sendHealth(first, PACKET_SAMPLES);
  assert.deepEqual(baseline.pcm, {
    acceptedFrameSerial: 1,
    mediaPath: 'websocket',
  });

  // The first physical WebSocket keeps accepting browser sends and health
  // round-trips, but its PCM payloads disappear before server acceptance.
  first.dropPcm = true;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    first.nowMs = 100 + sequence * 100;
    const result = transport.send(packet(sequence, sequence * PACKET_SAMPLES));
    assert.equal(result.sent, true);
    assert.equal(result.path, 'websocket');
    const ack = sendHealth(first, (sequence + 1) * PACKET_SAMPLES);
    assert.equal(ack.pcm.acceptedFrameSerial, 1);
  }

  assert.deepEqual(first.browserSocket.closeCalls, [
    { code: 4001, reason: 'server PCM stalled' },
  ], 'stale real server PCM requests exactly one physical publisher replacement');
  assert.equal(mic.acceptedFrameSerial, 1);

  // app.js reconnects the physical publisher socket without advancing the
  // capture generation. MicRuntime must therefore preserve receiver/timeline
  // authority and the accepted-frame serial across the replacement.
  assert.equal(first.detachServer(), true);
  const replacement = new SocketBridge(mic, session);
  const rebound = replacement.bindServer(500);
  assert.equal(rebound.preservedAudioTransport, true);
  assert.equal(rebound.captureReplaced, false);
  assert.equal(mic.mediaGeneration, GENERATION);
  assert.equal(mic.acceptedFrameSerial, 1);

  transport.bind(replacement.browserSocket);
  replacement.dropPcm = true;

  // The first current-socket health ACK rebaselines the new socket epoch. It
  // cannot inherit stale observations from the retired physical connection.
  replacement.nowMs = 500;
  assert.equal(transport.send(packet(4, PACKET_SAMPLES * 4)).sent, true);
  let ack = sendHealth(replacement, PACKET_SAMPLES * 5);
  assert.equal(ack.pcm.acceptedFrameSerial, 1);
  assert.equal((transport as any).lastMediaRecoveryDecision?.reason, 'socket-rebaseline');
  assert.equal(replacement.browserSocket.closeCalls.length, 0);

  // The bounded replacement gets one proof window. If server PCM still does
  // not advance, recovery must latch degraded instead of closing socket after
  // socket forever.
  for (let sequence = 5; sequence <= 7; sequence += 1) {
    replacement.nowMs = 100 + sequence * 100;
    assert.equal(transport.send(packet(sequence, sequence * PACKET_SAMPLES)).sent, true);
    ack = sendHealth(replacement, (sequence + 1) * PACKET_SAMPLES);
    assert.equal(ack.pcm.acceptedFrameSerial, 1);
  }
  assert.equal((transport as any).lastMediaRecoveryDecision?.action, 'degraded-latched');
  assert.equal((transport as any).lastMediaRecoveryDecision?.degraded, true);
  assert.equal(replacement.browserSocket.closeCalls.length, 0, 'degraded latch must stop the reconnect loop');

  replacement.nowMs = 900;
  assert.equal(transport.send(packet(8, PACKET_SAMPLES * 8)).sent, true);
  ack = sendHealth(replacement, PACKET_SAMPLES * 9);
  assert.equal(ack.pcm.acceptedFrameSerial, 1);
  assert.equal((transport as any).lastMediaRecoveryDecision?.reason, 'degraded-latched');
  assert.equal(replacement.browserSocket.closeCalls.length, 0);

  // A spontaneous media recovery on the same replacement socket may clear the
  // visible degraded verdict, but it must not restore the already-consumed
  // action budget or erase the same-generation WT quarantine.
  replacement.dropPcm = false;
  replacement.nowMs = 1_000;
  assert.equal(transport.send(packet(9, PACKET_SAMPLES * 9)).sent, true);
  assert.equal(mic.acceptedFrameSerial, 2);
  ack = sendHealth(replacement, PACKET_SAMPLES * 10);
  assert.equal(ack.pcm.acceptedFrameSerial, 2);
  assert.equal((transport as any).lastMediaRecoveryDecision?.action, 'recovered');
  assert.equal((transport as any).lastMediaRecoveryDecision?.webSocketReplacementUsed, true);
  assert.equal((transport as any).lastMediaRecoveryDecision?.webTransportQuarantined, true);
  assert.equal(replacement.browserSocket.closeCalls.length, 0);

  assert.deepEqual(
    replacement.acceptedFrames,
    [{ generation: GENERATION, firstSampleIndex: PACKET_SAMPLES * 9, sampleCount: PACKET_SAMPLES }],
  );
  assert.equal(session.health().micGapMs, 80, 'same-generation reconnect must preserve the eight-packet loss hole');
  assert.equal(mic.receiverStats()?.lostPackets, 8);
  assert.equal(mic.receiverStats()?.emittedPackets, 2);
  assert.equal(mic.mediaGeneration, GENERATION);
  assert.equal(mic.mediaOwnerId, PARTICIPANT_ID);
  assert.equal(mic.frameAgeMs(1_000), 0);

  transport.close();
  mic.clearMediaAuthority(1_100);
});
