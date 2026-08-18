import assert from 'node:assert/strict';
import test from 'node:test';

import { AudioSession } from '../src/audio-session.js';
import { decodePcmFrame } from '../src/pcm-frame.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FRAME_MS = 20;
const FRAME_SAMPLES = RATE * FRAME_MS / 1_000;
const FRAME_BYTES = FRAME_SAMPLES * Int16Array.BYTES_PER_ELEMENT;

function makeSession() {
  return new AudioSession({
    sampleRate: RATE,
    frameMs: FRAME_MS,
    prebufferMs: 0,
    backingGain: 1,
    retentionMs: 1_000,
  });
}

async function waitForBinaryFrames(client: RelayClient, count: number, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (client.binaryPayloads.length < count && Date.now() < deadline) await sleep(10);
  assert.ok(
    client.binaryPayloads.length >= count,
    `expected ${count} binary frames, saw ${client.binaryPayloads.length}`,
  );
}

test('AudioSession drain exposes the authoritative mix generation and sample index', () => {
  const session = makeSession();
  session.start(0);

  const positions: Array<{ generation: number; firstSampleIndex: number }> = [];
  session.drain((_frame, _evidence, position) => positions.push(position), 40, 10);

  assert.deepEqual(
    positions.map((position) => position.firstSampleIndex),
    [0, FRAME_SAMPLES, FRAME_SAMPLES * 2],
  );
  assert.ok(positions.every((position) => position.generation === session.generation));

  const previousGeneration = session.generation;
  session.resetEpoch(100);
  const restarted: Array<{ generation: number; firstSampleIndex: number }> = [];
  session.drain((_frame, _evidence, position) => restarted.push(position), 100, 1);

  assert.equal(restarted.length, 1);
  assert.equal(restarted[0].firstSampleIndex, 0);
  assert.ok(restarted[0].generation > previousGeneration);
});

test('framed monitor opt-in gets positioned mix PCM while legacy monitor stays raw', async () => {
  const server = await startRelay({
    RELAY_LIVE_PREBUFFER_MS: '100',
    RELAY_AUTO_CALIBRATE: '0',
    RELAY_HEARTBEAT_MS: '60000',
  });

  const clients: RelayClient[] = [];
  try {
    const legacy = await RelayClient.connect(server);
    clients.push(legacy);
    legacy.send({ type: 'register', role: 'monitor' });
    const legacyRegistered = await legacy.waitForType('registered');
    assert.equal(legacyRegistered.monitorPacketVersion, undefined);

    const framed = await RelayClient.connect(server);
    clients.push(framed);
    framed.send({ type: 'register', role: 'monitor', monitorPacketVersion: 1 });
    const framedRegistered = await framed.waitForType('registered');
    assert.equal(framedRegistered.monitorPacketVersion, 1);

    const backing = await RelayClient.connect(server);
    clients.push(backing);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');

    const publisher = await RelayClient.connect(server);
    clients.push(publisher);
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');

    const oneSecond = Buffer.alloc(RATE * Int16Array.BYTES_PER_ELEMENT);
    backing.sendPcm(oneSecond);
    publisher.sendPcm(oneSecond);

    await Promise.all([
      waitForBinaryFrames(legacy, 2),
      waitForBinaryFrames(framed, 2),
    ]);

    const legacyPacket = legacy.binaryPayloads[0];
    assert.equal(legacyPacket.byteLength, FRAME_BYTES);
    assert.equal(decodePcmFrame(legacyPacket).generation, null);

    const first = decodePcmFrame(framed.binaryPayloads[0]);
    const second = decodePcmFrame(framed.binaryPayloads[1]);
    assert.notEqual(first.generation, null);
    assert.equal(second.generation, first.generation);
    assert.notEqual(first.firstSampleIndex, null);
    assert.notEqual(second.firstSampleIndex, null);
    // A monitor can join an already-running mix after sample zero. What the
    // framing contract guarantees is an aligned authoritative position and a
    // continuous sample timeline between consecutive delivered frames.
    assert.equal(first.firstSampleIndex! % FRAME_SAMPLES, 0);
    assert.equal(second.firstSampleIndex, first.firstSampleIndex! + FRAME_SAMPLES);
    assert.equal(first.pcm.byteLength, FRAME_BYTES);
    assert.equal(second.pcm.byteLength, FRAME_BYTES);
  } finally {
    clients.forEach((client) => client.close());
    await server.stop();
  }
});

test('monitor rejects an unsupported framed PCM version instead of silently changing wire format', async () => {
  const server = await startRelay({ RELAY_HEARTBEAT_MS: '60000' });
  try {
    const monitor = await RelayClient.connect(server);
    monitor.send({ type: 'register', role: 'monitor', monitorPacketVersion: 2 });
    assert.match((await monitor.waitForType('error')).message, /monitor packet version/i);
    monitor.close();
  } finally {
    await server.stop();
  }
});
