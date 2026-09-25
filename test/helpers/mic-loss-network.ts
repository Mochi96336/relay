/**
 * Deterministic Mic uplink under a simulated network: the real page transport
 * (PreferredAudioTransport, answering repeat requests) and the real Relay side
 * (MicRuntime: ordered receiver, retransmit requests, hold) on a virtual
 * millisecond clock. Shared by the transport loss matrix, which scores emitted
 * packets, and the audible loss matrix, which mixes them and scores the PCM.
 */
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../../src/audio-uplink-health.js';
import { MicRuntime } from '../../src/mic-runtime.js';
import type { PcmFrame } from '../../src/pcm-frame.js';
import type { RelaySocket } from '../../src/relay-socket-server.js';
import { decodeRetransmitRequest } from '../../shared/retransmit-request.js';

export const PACKET_MS = 10;
/** Relay's fixed live prebuffer: how far behind capture the mix reads. */
export const PLAYOUT_DELAY_MS = 400;
export const MIXER_TICK_MS = 10;
/** Loss starts after the mix is established, as in a real session. */
export const WARMUP_PACKETS = 100;
const GENERATION = 31;

export type Rng = () => number;
export type PacketKind = 'media' | 'repeat' | 'request';
/**
 * One independent stream per packet kind, so the original media sees exactly
 * the same network whether or not repeats and requests are also on the wire.
 */
export type Rngs = Record<PacketKind, Rng>;

export function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export type Direction = {
  /** One-way base delay. */
  delayMs: number;
  /** Extra one-sided queueing delay, uniform in [0, jitterMs). */
  jitterMs: number;
  /** Decides whether one packet is lost, given the send time. */
  lose: (nowMs: number, kind: PacketKind, sequence: number) => boolean;
};

export type Scenario = {
  name: string;
  seconds: number;
  firstSequence?: number;
  uplink: (rngs: Rngs) => Direction;
  downlink: (rngs: Rngs) => Direction;
  /** Whether each request path is up at `nowMs`. */
  paths?: (nowMs: number) => { direct: boolean; control: boolean };
  /**
   * Whether the page's own media socket is open at `nowMs`. While it is not,
   * the page drops packets as disconnected instead of the network losing them.
   */
  pageSocketUp?: (nowMs: number) => boolean;
  /**
   * Which path media sent at `nowMs` arrives on. WebTransport by default;
   * 'websocket' delivers through the publisher socket, as after a demotion.
   */
  mediaPath?: (nowMs: number) => 'webtransport' | 'websocket';
};

export type Outcome = {
  sent: number;
  lostOnWire: number;
  heard: number;
  missing: number;
  recovered: number;
  retried: number;
  requested: number;
  budgetDenied: number;
  /** Packet indices not heard in time, with when they were emitted (or null). */
  missed: [number, number | null][];
};

export type UplinkRun = {
  scenario: Scenario;
  pageRetransmits: boolean;
  seed: number;
  sampleRate?: number;
  /** Capture PCM for one packet. Defaults to a constant byte per packet. */
  pcm?: (index: number, firstSampleIndex: number, samples: number) => Buffer;
  /**
   * The live mix headroom Relay reports to its repair service. Defaults to
   * how far the next packet is from a fixed 400 ms playout deadline.
   */
  mixHeadroomMs?: (nowMs: number) => number | null;
  /** Every frame MicRuntime hands the mixer, in order, as production does. */
  onFrames?: (frames: PcmFrame[], nowMs: number) => void;
  /** After each mixer tick's flush. */
  onMixerTick?: (nowMs: number) => void;
};

function health(capturedSamples: number): AudioUplinkHealth {
  return {
    version: 1,
    captureGeneration: GENERATION,
    capturedSamples,
    inputGapSamples: 0,
    inputGapActive: false,
    inputMuted: false,
    capture: null,
    captureLevel: null,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path: 'webtransport',
      maxPacketBytes: 1_200,
      minWebTransportMaxPacketBytes: 1_200,
      maxWebTransportMaxPacketBytes: 1_200,
      datagramPacketBytesCeiling: 1_200,
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

/** The page's outbound socket: everything it sends lands on the uplink. */
class PageSocket {
  readyState = 1;
  bufferedAmount = 0;
  outbox: Uint8Array[] = [];
  send(payload: unknown) {
    if (payload instanceof Uint8Array) this.outbox.push(new Uint8Array(payload));
    else if (payload instanceof ArrayBuffer) this.outbox.push(new Uint8Array(payload.slice(0)));
  }
  addEventListener() {}
  removeEventListener() {}
}

export async function simulateMicUplink(run: UplinkRun): Promise<Outcome> {
  const { scenario, pageRetransmits, seed } = run;
  const sampleRate = run.sampleRate ?? 48_000;
  const packetSamples = Math.round((sampleRate * PACKET_MS) / 1_000);
  const { PreferredAudioTransport } = await import(new URL('../../public/audio-transport.js', import.meta.url).href);
  const page = new PreferredAudioTransport({ retransmitBufferPackets: pageRetransmits ? 128 : 0 });
  const pageSocket = new PageSocket();
  page.bind(pageSocket);

  let nowMs = 0;
  const paths = () => scenario.paths?.(nowMs) ?? { direct: true, control: true };
  const downlinkQueue: { at: number; request: { captureGeneration: number; attempt: number; sequences: number[] } }[] = [];
  const uplinkQueue: { at: number; bytes: Buffer; path: 'webtransport' | 'websocket' }[] = [];
  const rngs = (base: number): Rngs => ({
    media: seeded(base),
    repeat: seeded(base + 1),
    request: seeded(base + 2),
  });
  const uplink = scenario.uplink(rngs(seed * 101));
  const downlink = scenario.downlink(rngs(seed * 211));
  const jitter = rngs(seed * 307);

  const relayRequest = (request: { captureGeneration: number; attempt: number; sequences: number[] }) => {
    if (downlink.lose(nowMs, 'request', request.sequences[0] ?? 0)) return;
    downlinkQueue.push({ at: nowMs + downlink.delayMs + jitter.request() * downlink.jitterMs, request });
  };

  const mic = new MicRuntime({
    audioTransportConfig: DEFAULT_AUDIO_TRANSPORT_CONFIG as never,
    firstFrameTimeoutMs: 3_000,
    streamLiveMs: 1_000,
    createDirectMediaTicket: () => 'ticket-matrix',
    directMediaConnected: () => paths().direct,
    offerDirectMedia: (ticket) => ({ ticket }) as never,
    sendDirectMedia: (_ticket, bytes) => {
      const request = decodeRetransmitRequest(bytes);
      assert.ok(request);
      relayRequest(request);
      return true;
    },
  });
  const publisher = {
    get readyState() {
      return paths().control ? WebSocket.OPEN : WebSocket.CLOSED;
    },
    role: 'publisher',
    isAlive: true,
    participantId: 'participant-matrix',
    send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type !== 'audio-retransmit-request') return;
      relayRequest({
        captureGeneration: message.captureGeneration,
        attempt: message.attempt ?? 0,
        sequences: message.sequences,
      });
    },
  } as unknown as RelaySocket;
  mic.bindPublisher({
    socket: publisher,
    sampleRate,
    captureGeneration: GENERATION,
    audioPacketVersion: 2,
    nowMs: 0,
  });
  // The page reports uplink health once a second over the control socket.
  const reportHealth = (capturedSamples: number) => {
    const report = health(capturedSamples);
    if (!pageRetransmits) delete report.transport.retransmitBufferPackets;
    return mic.noteUplinkHealth(publisher, report, nowMs);
  };
  assert.equal(reportHealth(0), true);

  const firstSequence = scenario.firstSequence ?? 0;
  // Numbered as public/app.js numbers them: a packet spends its sequence only
  // when the transport sent it or kept it for repair. A harness that spent one
  // per captured packet proved repair for holes the real page never exposed.
  let nextSequence = firstSequence;
  const total = Math.round((scenario.seconds * 1_000) / PACKET_MS);
  const playoutAt = (index: number) => uplink.delayMs + index * PACKET_MS + PLAYOUT_DELAY_MS;
  const heardAt = new Map<number, number>();
  let lastEmittedIndex = -1;
  let lostOnWire = 0;
  const originals = new Set<string>();
  const mediaPath = () => scenario.mediaPath?.(nowMs) ?? 'webtransport';

  const drainPageSocket = () => {
    for (const bytes of pageSocket.outbox) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const sequence = view.getUint32(8, true);
      const key = String(sequence);
      const kind = originals.has(key) ? 'repeat' : 'media';
      originals.add(key);
      if (uplink.lose(nowMs, kind, sequence)) {
        if (kind === 'media') lostOnWire += 1;
        continue;
      }
      uplinkQueue.push({
        at: nowMs + uplink.delayMs + jitter[kind]() * uplink.jitterMs,
        bytes: Buffer.from(bytes),
        path: mediaPath(),
      });
    }
    pageSocket.outbox.length = 0;
  };

  const collect = (frames: PcmFrame[]) => {
    for (const frame of frames) {
      const index = Math.round(frame.firstSampleIndex! / packetSamples) - firstSequence;
      heardAt.set(index, nowMs);
      lastEmittedIndex = Math.max(lastEmittedIndex, index);
    }
    if (frames.length > 0) run.onFrames?.(frames, nowMs);
  };

  const mixHeadroomMs = run.mixHeadroomMs
    ?? ((atMs: number) => (lastEmittedIndex < 0 ? null : playoutAt(lastEmittedIndex + 1) - atMs));

  const endMs = total * PACKET_MS + PLAYOUT_DELAY_MS + 1_000;
  for (nowMs = 0; nowMs <= endMs; nowMs += 1) {
    if (nowMs > 0 && nowMs % 1_000 === 0 && paths().control) {
      reportHealth((nowMs / PACKET_MS) * packetSamples);
    }

    pageSocket.readyState = scenario.pageSocketUp?.(nowMs) === false ? 3 : 1;

    // Page: capture one packet every 10 ms.
    if (nowMs % PACKET_MS === 0 && nowMs / PACKET_MS < total) {
      const index = nowMs / PACKET_MS;
      const sequence = nextSequence >>> 0;
      const firstSampleIndex = (firstSequence + index) * packetSamples;
      const bytes = encodeAudioPacket({
        source: 'mic',
        generation: GENERATION,
        sequence,
        firstSampleIndex,
        pcm: run.pcm?.(index, firstSampleIndex, packetSamples)
          ?? Buffer.alloc(packetSamples * 2, index & 0xff),
      });
      const packetBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
      const result = page.send(packetBytes.buffer);
      if (result.sent || result.retained) nextSequence += 1;
      if (index < WARMUP_PACKETS) {
        // The warm-up is delivered untouched so every run starts from a live mix.
        originals.add(String(sequence));
        for (const sent of pageSocket.outbox) {
          uplinkQueue.push({ at: nowMs + uplink.delayMs, bytes: Buffer.from(sent), path: mediaPath() });
        }
        pageSocket.outbox.length = 0;
      }
    }

    // Requests reaching the page are answered at once.
    for (let i = 0; i < downlinkQueue.length;) {
      if (downlinkQueue[i]!.at <= nowMs) {
        page.answerRetransmitRequest(downlinkQueue[i]!.request);
        downlinkQueue.splice(i, 1);
      } else {
        i += 1;
      }
    }
    drainPageSocket();

    // Network delivery to Relay.
    for (let i = 0; i < uplinkQueue.length;) {
      const entry = uplinkQueue[i]!;
      if (entry.at <= nowMs) {
        collect(entry.path === 'websocket'
          ? mic.receivePublisher(publisher, entry.bytes, nowMs)
          : mic.receiveDirectMedia('ticket-matrix', entry.bytes, nowMs));
        uplinkQueue.splice(i, 1);
      } else {
        i += 1;
      }
    }

    // Relay mixer tick: requests first, then the ordered flush.
    if (nowMs % MIXER_TICK_MS === 0) {
      mic.serviceRetransmits(nowMs, mixHeadroomMs(nowMs));
      collect(mic.flush(nowMs));
      run.onMixerTick?.(nowMs);
    }
  }

  let heard = 0;
  const missed: [number, number | null][] = [];
  for (let index = 0; index < total; index += 1) {
    const at = heardAt.get(index);
    if (at !== undefined && at <= playoutAt(index)) heard += 1;
    else missed.push([index, at === undefined ? null : at - playoutAt(index)]);
  }
  const stats = mic.retransmitStats()!;
  return {
    sent: total,
    lostOnWire,
    heard,
    missing: total - heard,
    recovered: stats.recoveredPackets,
    retried: stats.retriedPackets,
    requested: stats.requestedPackets,
    budgetDenied: stats.budgetDeniedPackets,
    missed,
  };
}

export const clean = (delayMs: number, jitterMs = 0): ((rngs: Rngs) => Direction) => () => ({
  delayMs,
  jitterMs,
  lose: () => false,
});

export const randomLoss = (rate: number, delayMs: number, jitterMs: number) => (rngs: Rngs): Direction => ({
  delayMs,
  jitterMs,
  lose: (_nowMs, kind) => rngs[kind]() < rate,
});

/** Gilbert-Elliott: mostly clean, with bursts that drop most packets. */
export const burstyLoss = (enterBurst: number, meanBurstPackets: number, delayMs: number) => (rngs: Rngs): Direction => {
  // The channel state advances with the media stream; anything else sent
  // meanwhile shares whatever state the channel is in.
  let inBurst = false;
  return {
    delayMs,
    jitterMs: 10,
    lose: (_nowMs, kind) => {
      if (kind === 'media') {
        inBurst = inBurst ? rngs.media() >= 1 / meanBurstPackets : rngs.media() < enterBurst;
      }
      return inBurst ? rngs[kind]() < 0.9 : rngs[kind]() < 0.005;
    },
  };
};
