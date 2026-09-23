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
const PARTICIPANT_ID = 'participant-generation-transition-proof';

function packet(generation: number, sequence: number, firstSampleIndex: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation,
    sequence,
    firstSampleIndex,
    pcm: Buffer.alloc(PACKET_SAMPLES * 2),
  });
}

function health(
  generation: number,
  capturedSamples: number,
  path: 'webtransport' | 'websocket',
) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: generation,
    capturedSamples,
    transport: { path },
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

class GenerationBridge {
  nowMs = 0;
  readonly browserSocket: BrowserSocket;
  readonly serverSocket: RelaySocket;
  readonly acceptedFrames: Array<{ generation: number; firstSampleIndex: number; sampleCount: number }> = [];
  private readonly pendingServerMessages: string[] = [];

  constructor(
    private readonly mic: MicRuntime,
    private readonly session: AudioSession,
    readonly generation: number,
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
      captureGeneration: this.generation,
      audioPacketVersion: 2,
      nowMs,
    });
  }

  detachServer() {
    return this.mic.detachPublisher(this.serverSocket);
  }

  acceptDirect(ticket: string, payload: Uint8Array) {
    this.acceptFrames(this.mic.receiveDirectMedia(
      ticket,
      Buffer.from(payload),
      this.nowMs,
    ));
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

  private acceptFrames(frames: ReturnType<MicRuntime['receivePublisher']>) {
    for (const frame of frames) {
      const ingested = this.session.ingestMic(frame, this.mic.sampleRate, this.nowMs);
      if (ingested.samples.length < 1) continue;
      assert.ok(
        typeof frame.generation === 'number' && typeof frame.firstSampleIndex === 'number',
        'accepted v2 proof frames must retain generation and sample-frontier identity',
      );
      this.mic.noteFrame(this.nowMs);
      this.acceptedFrames.push({
        generation: frame.generation,
        firstSampleIndex: frame.firstSampleIndex,
        sampleCount: frame.pcm.byteLength / 2,
      });
    }
  }

  takeServerMessages() {
    return this.pendingServerMessages.splice(0);
  }

  flushServerMessages() {
    const messages = this.takeServerMessages();
    for (const message of messages) this.browserSocket.emitText(message);
    return messages.map((message) => JSON.parse(message));
  }
}

class BridgeDatagramWriter {
  constructor(private readonly onWrite: (payload: Uint8Array) => void) {}

  async write(payload: Uint8Array) {
    this.onWrite(new Uint8Array(payload));
  }

  releaseLock() {}
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
  private readonly closeHook: () => void;
  private resolveClosed!: () => void;
  private closedOnce = false;

  constructor(readonly url: string) {
    const writeHook = BridgeWebTransport.onWrite;
    this.closeHook = BridgeWebTransport.onClose;
    this.writer = new BridgeDatagramWriter(writeHook);
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
    this.closeHook();
    this.resolveClosed();
  }
}

function session() {
  const value = new AudioSession({
    sampleRate: SAMPLE_RATE,
    frameMs: 20,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 5_000,
  });
  value.setMicGainDb(0);
  value.start(0);
  value.setMicExpected(true);
  return value;
}

test('capture-generation advance clears recovery/FIFO authority and fences every late old-generation signal', async () => {
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
    createDirectMediaTicket: () => `generation-ticket-${++nextTicket}`,
    directMediaConnected: (ticket) => Boolean(ticket && activeTickets.has(ticket)),
    offerDirectMedia: (ticket) => ({ ticket }),
  });

  const generation7 = new GenerationBridge(mic, session(), 7);
  assert.equal(generation7.bindServer(0).preservedAudioTransport, false);
  const ticket7 = mic.mediaTicket!;
  activeTickets.add(ticket7);

  let dropDirect = false;
  BridgeWebTransport.instances.length = 0;
  BridgeWebTransport.onWrite = (payload) => {
    if (!dropDirect) generation7.acceptDirect(ticket7, payload);
  };
  BridgeWebTransport.onClose = () => {
    activeTickets.delete(ticket7);
  };

  const { PreferredAudioTransport } = await import(moduleUrl.href);
  const transport = new PreferredAudioTransport({ WebTransportClass: BridgeWebTransport });
  transport.bind(generation7.browserSocket);
  assert.equal(await transport.prefer({
    preferred: 'webtransport',
    url: 'https://relay.test/media-generation-7',
  }), true);

  const sendHealth = (bridge: GenerationBridge, capturedSamples: number) => {
    const path = transport.stats().path as 'webtransport' | 'websocket';
    assert.equal(
      transport.sendControlJson(health(bridge.generation, capturedSamples, path)).sent,
      true,
    );
    const messages = bridge.flushServerMessages();
    const ack = messages.find((message) => message?.type === 'audio-uplink-health-ack');
    assert.ok(ack, 'real MicRuntime must ACK current-generation health on the active socket');
    return ack;
  };

  // Establish true server PCM progress for generation 7, then make subsequent
  // WT writes resolve locally while disappearing before server acceptance.
  generation7.nowMs = 100;
  assert.equal(transport.send(packet(7, 0, 0)).sent, true);
  await Promise.resolve();
  assert.equal(mic.acceptedFrameSerial, 1);
  assert.deepEqual(sendHealth(generation7, PACKET_SAMPLES).pcm, {
    acceptedFrameSerial: 1,
    receivedPacketSerial: 1,
    receivedSampleSerial: PACKET_SAMPLES,
    mediaPath: 'webtransport',
  });

  dropDirect = true;
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    generation7.nowMs = 100 + sequence * 100;
    assert.equal(transport.send(packet(7, sequence, sequence * PACKET_SAMPLES)).sent, true);
    await Promise.resolve();
    const ack = sendHealth(generation7, (sequence + 1) * PACKET_SAMPLES);
    assert.equal(ack.pcm.acceptedFrameSerial, 1);
  }

  assert.equal(transport.stats().path, 'websocket');
  assert.equal(BridgeWebTransport.instances[0].closeCalls, 1);
  assert.equal(
    await transport.prefer({ preferred: 'webtransport', url: 'https://relay.test/media-generation-7-retry' }),
    false,
    'failed WT is quarantined for the old capture generation',
  );

  // Leave one valid generation-7 health ACK in flight on the still-current
  // physical control socket. Both browser FIFO state and server message exist.
  generation7.nowMs = 500;
  assert.equal(
    transport.sendControlJson(health(7, PACKET_SAMPLES * 5, 'websocket')).sent,
    true,
  );
  const oldAckMessages = generation7.takeServerMessages();
  assert.equal(oldAckMessages.length, 1);
  const lateGeneration7Ack = oldAckMessages[0];
  assert.equal(JSON.parse(lateGeneration7Ack).captureGeneration, 7);

  // app.js calls resetStats() exactly when captureGeneration advances. This is
  // the browser-side authority boundary: stale recovery budget, WT quarantine,
  // and the pending health FIFO all belong to generation 7 and must disappear.
  transport.resetStats();
  assert.equal((transport as any).lastMediaRecoveryDecision, null);

  // Deliver the already-generated old ACK before the physical socket changes.
  // A cleared pending FIFO must make it inert even though the old listener is
  // still attached and the ACK is otherwise structurally valid.
  generation7.browserSocket.emitText(lateGeneration7Ack);
  assert.equal((transport as any).lastMediaRecoveryDecision, null);
  assert.equal(generation7.browserSocket.closeCalls.length, 0);

  // The real server now admits the replacement capture generation. A new
  // generation is not a same-capture reconnect: receiver/ticket/flow evidence
  // are replaced and accepted-frame serial restarts from zero.
  assert.equal(generation7.detachServer(), true);
  const generation8 = new GenerationBridge(mic, session(), 8);
  const generation8Bind = generation8.bindServer(600);
  assert.equal(generation8Bind.preservedAudioTransport, false);
  assert.equal(generation8Bind.captureReplaced, true);
  assert.equal(mic.mediaGeneration, 8);
  assert.equal(mic.acceptedFrameSerial, 0);
  const ticket8 = mic.mediaTicket!;
  assert.notEqual(ticket8, ticket7);

  transport.bind(generation8.browserSocket);

  // A second delivery of the retired ACK cannot cross the physical-socket
  // listener/epoch fence either. It must not create a generation-8 verdict.
  generation7.browserSocket.emitText(lateGeneration7Ack);
  assert.equal((transport as any).lastMediaRecoveryDecision, null);

  // Old media authority is fenced independently of control evidence.
  assert.deepEqual(
    mic.receivePublisher(generation7.serverSocket, packet(7, 4, PACKET_SAMPLES * 4), 650),
    [],
  );
  assert.deepEqual(
    mic.receiveDirectMedia(ticket7, packet(7, 4, PACKET_SAMPLES * 4), 650),
    [],
  );
  assert.equal(mic.acceptedFrameSerial, 0);

  // Generation 8 gets a fresh recovery budget and may prefer WT again. Its
  // first real server-accepted frame establishes a brand-new authoritative
  // frontier; none of generation 7's serial/FIFO/quarantine state is inherited.
  activeTickets.add(ticket8);
  BridgeWebTransport.onWrite = (payload) => generation8.acceptDirect(ticket8, payload);
  BridgeWebTransport.onClose = () => {
    activeTickets.delete(ticket8);
  };
  assert.equal(await transport.prefer({
    preferred: 'webtransport',
    url: 'https://relay.test/media-generation-8',
  }), true);
  assert.equal(BridgeWebTransport.instances.length, 2);
  assert.equal(transport.stats().path, 'webtransport');

  generation8.nowMs = 700;
  assert.equal(transport.send(packet(8, 0, 0)).sent, true);
  await Promise.resolve();
  assert.equal(mic.acceptedFrameSerial, 1);
  const generation8Ack = sendHealth(generation8, PACKET_SAMPLES);
  assert.equal(generation8Ack.captureGeneration, 8);
  assert.deepEqual(generation8Ack.pcm, {
    acceptedFrameSerial: 1,
    receivedPacketSerial: 1,
    mediaPath: 'webtransport',
  });
  assert.equal((transport as any).lastMediaRecoveryDecision?.captureGeneration, 8);
  assert.equal((transport as any).lastMediaRecoveryDecision?.webTransportQuarantined, false);
  assert.equal((transport as any).lastMediaRecoveryDecision?.webTransportDemotionUsed, false);
  assert.deepEqual(generation8.acceptedFrames, [
    { generation: 8, firstSampleIndex: 0, sampleCount: PACKET_SAMPLES },
  ]);
  assert.equal(mic.mediaGeneration, 8);
  assert.equal(mic.mediaOwnerId, PARTICIPANT_ID);
  assert.equal(mic.frameAgeMs(700), 0);

  transport.close();
  mic.clearMediaAuthority(800);
});
