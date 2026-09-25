/**
 * Lossy-uplink simulation against a real Relay process, on the wall clock.
 * The deterministic loss matrices that gate CI are test/mic-loss-matrix.test.ts
 * (packets heard in time) and test/mic-audible-loss-matrix.test.ts (the mixed
 * PCM); this bench is the end-to-end cross-check. Not part of `npm test` (the file
 * name does not match test/*.test.ts); run it directly:
 *
 *   node --import tsx test/loss-simulation.bench.ts
 *
 * A paced 48 kHz Mic stream is sent as 10 ms datagram-sized packets with
 * random loss and one-sided queueing jitter. The simulated page answers
 * retransmission requests after a configurable round trip, or never.
 */
import { encodeAudioPacket } from '../src/audio-packet.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const PACKET_SAMPLES = 480;
const PACKET_MS = 10;

type Scenario = {
  name: string;
  lossRate: number;
  jitterMs: number;
  answerRetransmits: boolean;
  retransmitRttMs: number;
};

function tone(sequence: number) {
  const pcm = Buffer.alloc(PACKET_SAMPLES * 2);
  for (let i = 0; i < PACKET_SAMPLES; i += 1) {
    const t = (sequence * PACKET_SAMPLES + i) / 48_000;
    pcm.writeInt16LE(Math.round(6_000 * Math.sin(2 * Math.PI * 220 * t)), i * 2);
  }
  return pcm;
}

function health(generation: number, capturedSamples: number, retransmitBufferPackets?: number) {
  return {
    type: 'audio-uplink-health',
    version: 1,
    captureGeneration: generation,
    capturedSamples,
    inputGapSamples: 0,
    inputMuted: false,
    droppedSamples: { total: 0, disconnected: 0, congested: 0, packetTooLarge: 0 },
    controlReconnects: 0,
    transport: {
      path: 'websocket',
      maxPacketBytes: null,
      minWebTransportMaxPacketBytes: null,
      maxWebTransportMaxPacketBytes: null,
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
      ...(retransmitBufferPackets === undefined ? {} : { retransmitBufferPackets }),
    },
  };
}

let seed = 12_345;
function random() {
  seed = (seed * 1_103_515_245 + 12_345) >>> 0;
  return (seed >>> 8) / 16_777_216;
}

async function run(scenario: Scenario, seconds: number) {
  seed = 12_345;
  const server = await startRelay({ RELAY_AUTO_CALIBRATE: '0', RELAY_HEARTBEAT_MS: '60000' });
  try {
    const generation = 21;
    const publisher = await RelayClient.connect(server, `?participant=bench-${Date.now()}&name=Bench`);
    publisher.send({
      type: 'register',
      role: 'publisher',
      sampleRate: 48_000,
      captureGeneration: generation,
      audioPacketVersion: 2,
    });
    await publisher.waitForType('registered');

    const packets = new Map<number, Buffer>();
    const packetFor = (sequence: number) => {
      let packet = packets.get(sequence);
      if (!packet) {
        packet = encodeAudioPacket({
          source: 'mic',
          generation,
          sequence,
          firstSampleIndex: sequence * PACKET_SAMPLES,
          pcm: tone(sequence),
        });
        packets.set(sequence, packet);
      }
      return packet;
    };

    let answeredIndex = 0;
    const answerRequests = () => {
      const fresh = publisher.messages.slice(answeredIndex);
      answeredIndex = publisher.messages.length;
      if (!scenario.answerRetransmits) return;
      for (const message of fresh) {
        if (message.type !== 'audio-retransmit-request') continue;
        for (const sequence of message.sequences as number[]) {
          // The repeat can itself be lost.
          if (random() < scenario.lossRate) continue;
          setTimeout(() => publisher.sendBinary(packetFor(sequence)), scenario.retransmitRttMs);
        }
      }
    };

    const total = Math.round((seconds * 1000) / PACKET_MS);
    const startedAt = Date.now();
    for (let sequence = 0; sequence < total; sequence += 1) {
      while (Date.now() < startedAt + sequence * PACKET_MS) await sleep(1);
      if (sequence % 50 === 0) {
        publisher.send(health(
          generation,
          sequence * PACKET_SAMPLES,
          scenario.answerRetransmits ? 128 : undefined,
        ));
      }
      answerRequests();
      // The first second establishes the mix before loss starts.
      if (sequence > 100 && random() < scenario.lossRate) continue;
      const delay = sequence > 100 ? random() * scenario.jitterMs : 0;
      const packet = packetFor(sequence);
      if (delay < 1) publisher.sendBinary(packet);
      else setTimeout(() => publisher.sendBinary(packet), delay);
    }
    await sleep(600);
    answerRequests();
    await sleep(400);

    const status = await fetch(server.httpUrl('/statusz')).then((response) => response.json()) as any;
    publisher.close();
    const audio = status.audio;
    return {
      scenario: scenario.name,
      sentPackets: total,
      lostPackets: audio.receiverTransport.lostPackets,
      latePackets: audio.receiverTransport.latePackets,
      requested: audio.receiverRetransmit?.requestedPackets ?? 0,
      recovered: audio.receiverRetransmit?.recoveredPackets ?? 0,
      micGapMs: audio.timeline.micGapMs,
      micConcealedMs: audio.timeline.micConcealedMs,
      micStarvedFrames: audio.timeline.micStarvedFrames,
    };
  } finally {
    await server.stop();
  }
}

const scenarios: Scenario[] = [];
for (const lossRate of [0.02, 0.05, 0.1]) {
  scenarios.push(
    { name: `${lossRate * 100}% loss, no retransmit`, lossRate, jitterMs: 30, answerRetransmits: false, retransmitRttMs: 0 },
    { name: `${lossRate * 100}% loss, retransmit RTT 80 ms`, lossRate, jitterMs: 30, answerRetransmits: true, retransmitRttMs: 80 },
  );
}

const results = [];
for (const scenario of scenarios) results.push(await run(scenario, 10));
console.table(results);
