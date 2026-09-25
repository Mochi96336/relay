/**
 * Deterministic loss matrix for the Mic uplink: the real page transport
 * (PreferredAudioTransport, answering repeat requests) and the real Relay side
 * (MicRuntime: ordered receiver, retransmit requests, hold) joined by a
 * simulated network on a virtual millisecond clock.
 *
 * A packet counts as heard when Relay emits it in order before the live mix
 * reads it. Each scenario runs the same seeded network twice: with a page that
 * keeps a retransmission history and with one that does not. Retransmission
 * must recover loss where the round trip allows it, and must never make a
 * scenario worse than plain loss.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import WebSocket from 'ws';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { DEFAULT_AUDIO_TRANSPORT_CONFIG } from '../src/audio-transport-config.js';
import type { AudioUplinkHealth } from '../src/audio-uplink-health.js';
import { MicRuntime } from '../src/mic-runtime.js';
import type { RelaySocket } from '../src/relay-socket-server.js';
import { decodeRetransmitRequest } from '../shared/retransmit-request.js';

const RATE = 48_000;
const PACKET_SAMPLES = 480;
const PACKET_MS = 10;
/** Relay's fixed live prebuffer: how far behind capture the mix reads. */
const PLAYOUT_DELAY_MS = 400;
const MIXER_TICK_MS = 10;
/** Loss starts after the mix is established, as in a real session. */
const WARMUP_PACKETS = 100;
const GENERATION = 31;

type Rng = () => number;
type PacketKind = 'media' | 'repeat' | 'request';
/**
 * One independent stream per packet kind, so the original media sees exactly
 * the same network whether or not repeats and requests are also on the wire.
 */
type Rngs = Record<PacketKind, Rng>;

function seeded(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

type Direction = {
  /** One-way base delay. */
  delayMs: number;
  /** Extra one-sided queueing delay, uniform in [0, jitterMs). */
  jitterMs: number;
  /** Decides whether one packet is lost, given the send time. */
  lose: (nowMs: number, kind: PacketKind, sequence: number) => boolean;
};

type Scenario = {
  name: string;
  seconds: number;
  firstSequence?: number;
  uplink: (rngs: Rngs) => Direction;
  downlink: (rngs: Rngs) => Direction;
  /** Whether each request path is up at `nowMs`. */
  paths?: (nowMs: number) => { direct: boolean; control: boolean };
};

type Outcome = {
  sent: number;
  lostOnWire: number;
  heard: number;
  missing: number;
  recovered: number;
  retried: number;
  requested: number;
  /** Packet indices not heard in time, with when they were emitted (or null). */
  missed: [number, number | null][];
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

async function simulate(scenario: Scenario, pageRetransmits: boolean, seed: number): Promise<Outcome> {
  const { PreferredAudioTransport } = await import(new URL('../public/audio-transport.js', import.meta.url).href);
  const page = new PreferredAudioTransport({ retransmitBufferPackets: pageRetransmits ? 128 : 0 });
  const pageSocket = new PageSocket();
  page.bind(pageSocket);

  let nowMs = 0;
  const paths = () => scenario.paths?.(nowMs) ?? { direct: true, control: true };
  const downlinkQueue: { at: number; request: { captureGeneration: number; attempt: number; sequences: number[] } }[] = [];
  const uplinkQueue: { at: number; bytes: Buffer }[] = [];
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
    sampleRate: RATE,
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
  const total = Math.round((scenario.seconds * 1_000) / PACKET_MS);
  const playoutAt = (index: number) => uplink.delayMs + index * PACKET_MS + PLAYOUT_DELAY_MS;
  const heardAt = new Map<number, number>();
  let lastEmittedIndex = -1;
  let lostOnWire = 0;
  const originals = new Set<string>();

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
      uplinkQueue.push({ at: nowMs + uplink.delayMs + jitter[kind]() * uplink.jitterMs, bytes: Buffer.from(bytes) });
    }
    pageSocket.outbox.length = 0;
  };

  const collect = (frames: { firstSampleIndex: number | null }[]) => {
    for (const frame of frames) {
      const index = Math.round(frame.firstSampleIndex! / PACKET_SAMPLES) - firstSequence;
      heardAt.set(index, nowMs);
      lastEmittedIndex = Math.max(lastEmittedIndex, index);
    }
  };

  const endMs = total * PACKET_MS + PLAYOUT_DELAY_MS + 1_000;
  for (nowMs = 0; nowMs <= endMs; nowMs += 1) {
    if (nowMs > 0 && nowMs % 1_000 === 0 && paths().control) {
      reportHealth((nowMs / PACKET_MS) * PACKET_SAMPLES);
    }

    // Page: capture one packet every 10 ms.
    if (nowMs % PACKET_MS === 0 && nowMs / PACKET_MS < total) {
      const index = nowMs / PACKET_MS;
      const sequence = (firstSequence + index) >>> 0;
      const bytes = encodeAudioPacket({
        source: 'mic',
        generation: GENERATION,
        sequence,
        firstSampleIndex: (firstSequence + index) * PACKET_SAMPLES,
        pcm: Buffer.alloc(PACKET_SAMPLES * 2, index & 0xff),
      });
      const packetBytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength).slice();
      if (index < WARMUP_PACKETS) {
        // The warm-up is delivered untouched so every run starts from a live mix.
        page.send(packetBytes.buffer);
        originals.add(String(sequence));
        for (const sent of pageSocket.outbox) {
          uplinkQueue.push({ at: nowMs + uplink.delayMs, bytes: Buffer.from(sent) });
        }
        pageSocket.outbox.length = 0;
      } else {
        page.send(packetBytes.buffer);
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
      if (uplinkQueue[i]!.at <= nowMs) {
        collect(mic.receiveDirectMedia('ticket-matrix', uplinkQueue[i]!.bytes, nowMs));
        uplinkQueue.splice(i, 1);
      } else {
        i += 1;
      }
    }

    // Relay mixer tick: requests first, then the ordered flush.
    if (nowMs % MIXER_TICK_MS === 0) {
      const headroomMs = lastEmittedIndex < 0 ? null : playoutAt(lastEmittedIndex + 1) - nowMs;
      mic.serviceRetransmits(nowMs, headroomMs);
      collect(mic.flush(nowMs));
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
    missed,
  };
}

const clean = (delayMs: number, jitterMs = 0): ((rngs: Rngs) => Direction) => () => ({
  delayMs,
  jitterMs,
  lose: () => false,
});

const randomLoss = (rate: number, delayMs: number, jitterMs: number) => (rngs: Rngs): Direction => ({
  delayMs,
  jitterMs,
  lose: (_nowMs, kind) => rngs[kind]() < rate,
});

/** Gilbert-Elliott: mostly clean, with bursts that drop most packets. */
const burstyLoss = (enterBurst: number, meanBurstPackets: number, delayMs: number) => (rngs: Rngs): Direction => {
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

async function compare(scenario: Scenario, seed = 1) {
  const without = await simulate(scenario, false, seed);
  const withRepair = await simulate(scenario, true, seed);
  if (process.env.MIC_LOSS_MATRIX_REPORT) {
    console.log(JSON.stringify({
      scenario: scenario.name,
      seed,
      lostOnWire: without.lostOnWire,
      heardMissingWithout: without.missing,
      heardMissingWithRepair: withRepair.missing,
      requested: withRepair.requested,
      recovered: withRepair.recovered,
      retried: withRepair.retried,
    }));
  }
  return { without, withRepair };
}

describe('Mic loss matrix (virtual clock, real page and Relay transports)', () => {
  it('loses nothing on a clean path, with or without a history', async () => {
    const { without, withRepair } = await compare({
      name: 'clean',
      seconds: 5,
      uplink: clean(30, 20),
      downlink: clean(30, 20),
    });
    assert.equal(without.missing, 0);
    assert.equal(withRepair.missing, 0);
    assert.equal(withRepair.requested, 0, 'jitter alone is not loss');
  });

  it('waits out heavy jitter instead of discarding late packets', async () => {
    const { without, withRepair } = await compare({
      name: 'heavy jitter, no loss',
      seconds: 8,
      uplink: clean(30, 150),
      downlink: clean(30, 150),
    });
    // Up to 150 ms of queueing reorders far past the 40 ms reorder deadline,
    // but well inside the live buffer: even a page with no history loses nothing.
    assert.equal(without.missing, 0, `late packets discarded: ${JSON.stringify(without.missed.slice(0, 10))}`);
    assert.equal(withRepair.missing, 0);
  });

  for (const rate of [0.02, 0.05, 0.1]) {
    it(`repairs ${rate * 100}% random loss at an 80 ms round trip`, async () => {
      const { without, withRepair } = await compare({
        name: `random ${rate}`,
        seconds: 10,
        uplink: randomLoss(rate, 40, 20),
        downlink: randomLoss(rate, 40, 10),
      });
      assert.ok(without.missing >= without.lostOnWire * 0.9, 'without a history every loss is heard');
      assert.ok(
        withRepair.missing <= Math.max(2, without.missing * 0.15),
        `${withRepair.missing} of ${without.missing} losses still heard: ${JSON.stringify(withRepair.missed)} `
          + `(requested ${withRepair.requested}, recovered ${withRepair.recovered}, retried ${withRepair.retried})`,
      );
      if (rate >= 0.05) assert.ok(withRepair.retried > 0, 'lost repeats and requests were retried');
    });
  }

  it('repairs bursts of consecutive loss', async () => {
    const { without, withRepair } = await compare({
      name: 'bursty',
      seconds: 10,
      uplink: burstyLoss(0.01, 6, 40),
      downlink: randomLoss(0.01, 40, 10),
    });
    assert.ok(without.missing >= 30, `the burst model should hurt: ${without.missing}`);
    assert.ok(
      withRepair.missing <= without.missing * 0.25,
      `${withRepair.missing} of ${without.missing} burst losses still heard`,
    );
  });

  it('retries when every first repeat is lost', async () => {
    const { without, withRepair } = await compare({
      name: 'first repeats lost',
      seconds: 8,
      uplink: (rngs) => {
        const repeated = new Set<number>();
        return {
          delayMs: 40,
          jitterMs: 10,
          lose: (_nowMs, kind, sequence) => {
            if (kind === 'media') return rngs.media() < 0.03;
            // The first repeat of every hole is lost; a second one gets through.
            if (repeated.has(sequence)) return false;
            repeated.add(sequence);
            return true;
          },
        };
      },
      downlink: clean(40, 10),
    });
    assert.ok(withRepair.retried > 0);
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.3),
      `${withRepair.missing} of ${without.missing} heard with repeats lost`,
    );
  });

  it('keeps requests through a short outage of both request paths', async () => {
    const outages = (nowMs: number) => {
      // 60 ms of every 500 ms, both request paths are down.
      const down = nowMs > 1_500 && nowMs % 500 < 60;
      return { direct: !down, control: !down };
    };
    const { without, withRepair } = await compare({
      name: 'request path outages',
      seconds: 8,
      uplink: randomLoss(0.05, 40, 10),
      downlink: clean(40, 10),
      paths: outages,
    });
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.2),
      `${withRepair.missing} of ${without.missing} heard across request outages`,
    );
  });

  it('moves requests to the control socket when the direct session is lost', async () => {
    const { without, withRepair } = await compare({
      name: 'direct path lost',
      seconds: 8,
      uplink: randomLoss(0.05, 40, 10),
      downlink: clean(40, 10),
      paths: (nowMs) => ({ direct: nowMs < 4_000, control: true }),
    });
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.2),
      `${withRepair.missing} of ${without.missing} heard after the direct path went`,
    );
  });

  it('repairs across the uint32 sequence wrap', async () => {
    const { without, withRepair } = await compare({
      name: 'sequence wrap',
      seconds: 6,
      firstSequence: 0xffff_ffff - 250,
      uplink: randomLoss(0.05, 40, 10),
      downlink: clean(40, 10),
    });
    assert.ok(without.missing > 0);
    assert.ok(
      withRepair.missing <= Math.max(2, without.missing * 0.2),
      `${withRepair.missing} of ${without.missing} heard across the wrap`,
    );
  });

  for (const scenario of [
    {
      name: 'a round trip longer than the buffer',
      seconds: 8,
      uplink: randomLoss(0.05, 250, 30),
      downlink: randomLoss(0.05, 250, 30),
    },
    {
      name: '30% loss',
      seconds: 8,
      uplink: randomLoss(0.3, 40, 20),
      downlink: randomLoss(0.3, 40, 20),
    },
    {
      name: 'heavy jitter with loss',
      seconds: 8,
      uplink: randomLoss(0.05, 30, 150),
      downlink: randomLoss(0.05, 30, 150),
    },
  ] satisfies Scenario[]) {
    it(`is never worse than plain loss: ${scenario.name}`, async () => {
      for (const seed of [1, 2, 3]) {
        const { without, withRepair } = await compare(scenario, seed);
        assert.ok(
          withRepair.missing <= without.missing,
          `seed ${seed}: ${withRepair.missing} heard missing with repair vs ${without.missing} without; `
            + `only with repair: ${JSON.stringify(withRepair.missed.filter(([index]) => !without.missed.some(([other]) => other === index)))}`,
        );
      }
    });
  }
});
