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

function packet(sequence: number, firstSampleIndex: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation: 7,
    sequence,
    firstSampleIndex,
    pcm: Buffer.alloc(PACKET_SAMPLES * 2),
  });
}

function health(capturedSamples: number, path: 'webtransport' | 'websocket') {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: 7,
    capturedSamples,
    inputGapSamples: 0,
    inputMuted: false,
    capture: null,
    captureLevel: null,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path,
      maxPacketBytes: path === 'webtransport' ? 1_000 : null,
      minWebTransportMaxPacketBytes: path === 'webtransport' ? 1_200 : null,
      maxWebTransportMaxPacketBytes: path === 'webtransport' ? 1_200 : null,
      datagramPacketBytesCeiling: path === 'webtransport' ? 1_000 : null,
      datagramQueuePackets: path === 'webtransport' ? 4 : null,
      webTransportAttempts: path === 'webtransport' ? 1 : 0,
      webTransportConnections: path === 'webtransport' ? 1 : 0,
      webTransportDemotions: path === 'websocket' ? 1 : 0,
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
  closeCalls: Array<{ code?: number; reason?: string }> = [];
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
      participantId: 'participant-recovery-integration',
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
    this.acceptFrames(this.mic.receivePublisher(
      this.serverSocket,
      Buffer.from(payload as Uint8Array),
      this.nowMs,
    ));
  }

  acceptDirect(ticket: string, payload: Uint8Array) {
    this.acceptFrames(this.mic.receiveDirectMedia(
      ticket,
      Buffer.from(payload),
      this.nowMs,
    ));
  }

  private acceptFrames(frames: ReturnType<MicRuntime['receivePublisher']>) {
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

class BridgeDatagramWriter {
  released = false;

  constructor(private readonly onWrite: (payload: Uint8Array) => void) {}

  async write(payload: Uint8Array) {
    this.onWrite(new Uint8Array(payload));
  }

  releaseLock() {
    this.released = true;
  }
}

class BridgeWebTransport {
  static onWrite: (payload: Uint8Array) => void = () => {};
  static onClose: () => void = () => {};
  static instances: BridgeWebTransport[] = [];

  readonly ready = Promise.resolve();
  readonly writer: BridgeDatagramWriter;
  readonly datagrams: {
    maxDatagramSize: number;
    writable: { getWriter: () => BridgeDatagramWriter };
    outgoingHighWaterMark?: number;
  };
  readonly closed: Promise<void>;
  closeCalls = 0;
  private resolveClosed!: () => void;
  private closedOnce = false;

  constructor(readonly url: string) {
    this.writer = new BridgeDatagramWriter((payload) => BridgeWebTransport.onWrite(payload));
    this.datagrams = {
      maxDatagramSize: 1_200,
      writable: { getWriter: () => this.writer },
    };
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    BridgeWebTransport.instances.push(this);
  }

  close() {
    this.closeCalls += 1;
    if (this.closedOnce) return;
    this.closedOnce = true;
    BridgeWebTransport.onClose();
    this.resolveClosed();
  }
}

test('browser media recovery follows real server accepted-PCM progress and preserves the WT loss hole', async () => {
  const activeTickets = new Set<string>();
  let nextTicket = 0;
  const mic = new MicRuntime({
    audioTransportConfig: {
      reorderWindowPackets: 0,
      reorderDeadlineMs: 0,
      maxForwardJumpPackets: 32,
    },
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    uplinkHealthTimeoutMs: 60_000,
    createDirectMediaTicket: () => `recovery-ticket-${++nextTicket}`,
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

  const bridge = new ServerBridge(mic, session);
  mic.bindPublisher({
    socket: bridge.serverSocket,
    sampleRate: SAMPLE_RATE,
    captureGeneration: 7,
    audioPacketVersion: 2,
    nowMs: 0,
  });
  const ticket = mic.mediaTicket!;
  activeTickets.add(ticket);

  let dropWebTransport = false;
  BridgeWebTransport.instances.length = 0;
  BridgeWebTransport.onWrite = (payload) => {
    if (!dropWebTransport) bridge.acceptDirect(ticket, payload);
  };
  BridgeWebTransport.onClose = () => {
    activeTickets.delete(ticket);
  };

  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: BridgeWebTransport });
  transport.bind(bridge.browserSocket);
  assert.equal(await transport.prefer({
    preferred: 'webtransport',
    url: 'https://relay.test/media',
  }), true);
  assert.equal(transport.stats().path, 'webtransport');

  const sendHealth = (capturedSamples: number) => {
    const path = transport.stats().path as 'webtransport' | 'websocket';
    assert.equal(transport.sendControlJson(health(capturedSamples, path)).sent, true);
    const messages = bridge.flushServerMessages();
    const ack = messages.find((message) => message?.type === 'audio-uplink-health-ack');
    assert.ok(ack, 'real MicRuntime must answer every accepted current-generation health report');
    return ack;
  };

  bridge.nowMs = 100;
  assert.equal(transport.send(packet(0, 0)).sent, true);
  await Promise.resolve();
  assert.equal(mic.acceptedFrameSerial, 1);
  const baselineAck = sendHealth(PACKET_SAMPLES);
  assert.deepEqual(baselineAck.pcm, {
    acceptedFrameSerial: 1,
    receivedPacketSerial: 1,
    mediaPath: 'webtransport',
  });

  // Three captured packets now disappear after writer.write() accepts them.
  // The browser sender sees successful WT submission while the real server
  // accepted-PCM serial remains frozen at the baseline.
  dropWebTransport = true;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    bridge.nowMs = 100 + sequence * 100;
    const result = transport.send(packet(sequence, sequence * PACKET_SAMPLES));
    assert.equal(result.sent, true);
    assert.equal(result.path, 'webtransport');
    await Promise.resolve();
    const ack = sendHealth((sequence + 1) * PACKET_SAMPLES);
    assert.equal(ack.pcm.acceptedFrameSerial, 1);
  }

  assert.equal(transport.stats().path, 'websocket', 'stale real server progress demotes WT');
  assert.equal(BridgeWebTransport.instances[0].closeCalls, 1);
  assert.equal(mic.acceptedFrameSerial, 1, 'resolved WT writes cannot manufacture server PCM progress');
  assert.equal(mic.mediaGeneration, 7);

  // Fallback resumes at the true capture frontier. The first WS frame both
  // establishes the server-WS recovery baseline and exposes the three-packet
  // source gap to the unchanged server receiver/AudioSession timeline.
  bridge.nowMs = 500;
  const firstWs = transport.send(packet(4, PACKET_SAMPLES * 4));
  assert.equal(firstWs.sent, true);
  assert.equal(firstWs.path, 'websocket');
  assert.equal(mic.acceptedFrameSerial, 2);
  const wsBaselineAck = sendHealth(PACKET_SAMPLES * 5);
  assert.deepEqual(wsBaselineAck.pcm, {
    acceptedFrameSerial: 2,
    receivedPacketSerial: 2,
    mediaPath: 'websocket',
  });

  bridge.nowMs = 600;
  const secondWs = transport.send(packet(5, PACKET_SAMPLES * 5));
  assert.equal(secondWs.sent, true);
  assert.equal(secondWs.path, 'websocket');
  assert.equal(mic.acceptedFrameSerial, 3);
  const recoveredAck = sendHealth(PACKET_SAMPLES * 6);
  assert.deepEqual(recoveredAck.pcm, {
    acceptedFrameSerial: 3,
    receivedPacketSerial: 3,
    mediaPath: 'websocket',
  });

  assert.deepEqual(bridge.acceptedFrames, [
    { generation: 7, firstSampleIndex: 0, sampleCount: PACKET_SAMPLES },
    { generation: 7, firstSampleIndex: PACKET_SAMPLES * 4, sampleCount: PACKET_SAMPLES },
    { generation: 7, firstSampleIndex: PACKET_SAMPLES * 5, sampleCount: PACKET_SAMPLES },
  ]);
  assert.equal(session.health().micGapMs, 30, 'fallback must preserve the 30 ms WT loss hole');
  assert.equal(mic.receiverStats()?.lostPackets, 3);
  assert.equal(mic.receiverStats()?.emittedPackets, 3);
  assert.equal(mic.mediaGeneration, 7, 'transport recovery must not rebuild capture generation');
  assert.equal(mic.mediaOwnerId, 'participant-recovery-integration');
  assert.equal(mic.frameAgeMs(600), 0);
  assert.equal(bridge.browserSocket.closeCalls.length, 0, 'successful WS proof must not replace control');
  assert.equal(transport.stats().path, 'websocket');

  transport.close();
  mic.clearMediaAuthority(700);
});
