import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAudioPacket } from '../src/audio-packet.js';
import { RelayClient, sleep, startRelay, statusz } from './helpers/harness.js';
import { uplinkHealthReport } from './support/uplink-health.js';

const CHUNK = 960;

function uplinkHealth(generation: number, capturedSamples: number, retransmitBufferPackets?: number) {
  return {
    type: 'audio-uplink-health',
    ...uplinkHealthReport(generation, capturedSamples, {
      transport: retransmitBufferPackets === undefined ? {} : { retransmitBufferPackets },
    }),
  };
}

function tone(sequence: number) {
  const pcm = Buffer.alloc(CHUNK * 2);
  for (let i = 0; i < CHUNK; i += 1) {
    pcm.writeInt16LE(Math.round(6_000 * Math.sin((2 * Math.PI * 220 * (sequence * CHUNK + i)) / 48_000)), i * 2);
  }
  return pcm;
}

function packet(generation: number, sequence: number) {
  return encodeAudioPacket({
    source: 'mic',
    generation,
    sequence,
    firstSampleIndex: sequence * CHUNK,
    pcm: tone(sequence),
  });
}

async function runLoss(retransmitBufferPackets: number | undefined, tailPackets = 10) {
  const server = await startRelay({
    RELAY_AUTO_CALIBRATE: '0',
  });
  try {
    const generation = 11;
    const publisher = await RelayClient.connectAs(server, `participant-retransmit-${retransmitBufferPackets ?? 'none'}`, 'Retransmit');
    publisher.send({
      type: 'register',
      role: 'publisher',
      sampleRate: 48_000,
      captureGeneration: generation,
      audioPacketVersion: 2,
    });
    await publisher.waitForType('registered');

    // Pace by the wall clock, as a capture clock would. Chained short sleeps
    // drift slower than real time on coarse OS timers, which would drain the
    // very headroom this test depends on.
    const startedAt = Date.now();
    const untilDue = async (next: number) => {
      while (Date.now() < startedAt + next * 20) await sleep(2);
    };
    let sequence = 0;
    for (; sequence < 30; sequence += 1) {
      publisher.sendBinary(packet(generation, sequence));
      if (sequence % 10 === 0) publisher.send(uplinkHealth(generation, sequence * CHUNK, retransmitBufferPackets));
      await untilDue(sequence + 1);
    }

    const lost = sequence;
    const requestIndex = publisher.messages.length;
    sequence += 1;
    for (; sequence < lost + 4; sequence += 1) {
      publisher.sendBinary(packet(generation, sequence));
      await untilDue(sequence + 1);
    }
    const requests = publisher.messages
      .slice(requestIndex)
      .filter((message) => message.type === 'audio-retransmit-request');

    // Answer exactly as the page would: the original bytes, late.
    if (requests.length > 0) publisher.sendBinary(packet(generation, lost));
    for (; sequence < lost + tailPackets; sequence += 1) {
      publisher.sendBinary(packet(generation, sequence));
      await untilDue(sequence + 1);
    }

    const status = await statusz(server);
    publisher.close();
    return { requests, lost, status };
  } finally {
    await server.stop();
  }
}

test('Relay asks a capable page to repeat a lost Mic packet and splices it back in place', async () => {
  const { requests, lost, status } = await runLoss(128);

  assert.equal(requests.length, 1, 'one request for one hole');
  assert.deepEqual(requests[0], {
    type: 'audio-retransmit-request',
    version: 1,
    captureGeneration: 11,
    attempt: 0,
    sequences: [lost],
  });
  assert.equal(status.audio.receiverTransport.lostPackets, 0, 'the repeat arrived before the hole was given up');
  const { repairRoundTripMs, ...retransmit } = status.audio.receiverRetransmit;
  assert.deepEqual(retransmit, {
    requestedPackets: 1, recoveredPackets: 1, budgetDeniedPackets: 0, retriedPackets: 0,
    lateRepairPackets: 0, lateRepairRoundTripMs: null, lateRepairMaxMs: null,
  });
  assert.equal(typeof repairRoundTripMs, 'number', 'the repair round trip is measured');
  assert.equal(status.audio.timeline.micGapMs, 0, 'the mix never saw a hole');
  assert.ok('lastWindow' in status.audio.micAudibility, 'statusz carries the audibility monitor');
  assert.deepEqual(status.audio.micAudibility.activeEpisodes, []);
});

test('Relay never asks a page that keeps no retransmission history, and gives its hole up in time', async () => {
  // The hole still waits for a late arrival while the mix can afford it, so
  // keep streaming well past the hold before looking.
  const { requests, status } = await runLoss(undefined, 40);

  assert.equal(requests.length, 0);
  assert.equal(status.audio.receiverRetransmit.requestedPackets, 0);
  assert.equal(status.audio.receiverTransport.lostPackets, 1, 'the hole is ordinary loss');
  assert.equal(status.audio.timeline.micGapMs, 20);
  assert.ok(status.audio.timeline.micConcealedMs > 0, 'and concealment covers it audibly');
});
