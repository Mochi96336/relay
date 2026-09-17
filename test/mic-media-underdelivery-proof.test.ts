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
const PACKET_SAMPLES = 480; // 10 ms
const TOTAL_PACKETS = 400; // 4 s of capture time
const DELIVER_EVERY_PACKETS = 30; // only 10 ms reaches Relay every 300 ms
const GENERATION = 7;

function packet(sequence: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation: GENERATION,
    sequence,
    firstSampleIndex: sequence * PACKET_SAMPLES,
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
      webSocketPacketsSent: capturedSamples / PACKET_SAMPLES,
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

class ServerBridge {
  nowMs = 0;
  readonly browserSocket: BrowserSocket;
  readonly serverSocket: RelaySocket;
  private binarySendCount = 0;
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
      participantId: 'participant-underdelivery-proof',
      send: (payload: unknown) => {
        this.pendingServerMessages.push(String(payload));
      },
      close() {},
      terminate() {},
    } as unknown as RelaySocket;
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

    const sequence = this.binarySendCount;
    this.binarySendCount += 1;
    if (sequence % DELIVER_EVERY_PACKETS !== 0) return;

    const frames = this.mic.receivePublisher(
      this.serverSocket,
      Buffer.from(payload as Uint8Array),
      this.nowMs,
    );
    for (const frame of frames) {
      const ingested = this.session.ingestMic(frame, this.mic.sampleRate, this.nowMs);
      if (ingested.samples.length > 0) this.mic.noteFrame(this.nowMs);
    }
  }

  flushServerMessages() {
    const messages = this.pendingServerMessages.splice(0);
    for (const message of messages) this.browserSocket.emitText(message);
    return messages.map((message) => JSON.parse(message));
  }
}

test('sparse accepted PCM can keep freshness/recovery alive while the session accumulates severe holes', async () => {
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

  const bridge = new ServerBridge(mic, session);
  mic.bindPublisher({
    socket: bridge.serverSocket,
    sampleRate: SAMPLE_RATE,
    captureGeneration: GENERATION,
    audioPacketVersion: 2,
    nowMs: 0,
  });

  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport();
  transport.bind(bridge.browserSocket);

  const serialAtHealth: number[] = [];
  for (let sequence = 0; sequence < TOTAL_PACKETS; sequence += 1) {
    bridge.nowMs = sequence * 10;
    const result = transport.send(packet(sequence));
    assert.equal(result.sent, true);
    assert.equal(result.path, 'websocket');

    if ((sequence + 1) % 100 !== 0) continue;
    const capturedSamples = (sequence + 1) * PACKET_SAMPLES;
    assert.equal(transport.sendControlJson(health(capturedSamples)).sent, true);
    const messages = bridge.flushServerMessages();
    const ack = messages.find((message) => message?.type === 'audio-uplink-health-ack');
    assert.ok(ack, 'real MicRuntime must ACK each accepted current-generation health report');
    serialAtHealth.push(ack.pcm.acceptedFrameSerial);

    assert.equal(
      mic.streaming(bridge.nowMs),
      true,
      'one sparse novel packet inside the 1 s freshness window still reports the Mic as streaming',
    );
  }

  assert.equal(
    serialAtHealth.every((serial, index) => index === 0 || serial > serialAtHealth[index - 1]),
    true,
    'accepted-frame serial keeps advancing at every health observation despite extreme loss',
  );
  assert.equal(bridge.browserSocket.closeCalls.length, 0, 'event-progress recovery never spends a socket action');
  assert.equal(transport.stats().path, 'websocket');

  const receiver = mic.receiverStats();
  assert.equal(receiver?.emittedPackets, 14);
  assert.equal(receiver?.lostPackets, 377);
  assert.equal(session.health().micGapMs, 3_770);
  assert.equal(mic.acceptedFrameSerial, 14);
  assert.equal(mic.frameAgeMs(3_990), 90);
  assert.equal(mic.streaming(3_990), true);

  transport.close();
  mic.clearMediaAuthority(4_000);
});
