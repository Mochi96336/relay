import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseBroadcastTypes } from '../src/relay-socket-server.js';
import { RelayClient, sleep, startRelay, toInt16, pulseTrain } from './helpers/harness.js';

const RATE = 48_000;
const FRAME_SAMPLES = 960;

async function registerMonitor(client: RelayClient, extra: Record<string, unknown> = {}) {
  client.send({ type: 'register', role: 'monitor', monitorPacketVersion: 1, ...extra });
  await client.waitForType('registered');
  // The registration snapshot is sent directly and is not filtered. A reply
  // that is not part of it marks where the snapshot ends.
  client.send({ type: 'product-status-request' });
  await client.waitForType('product-status');
  return client.messages.length;
}

function typesSince(client: RelayClient, from: number) {
  return new Set(client.messages.slice(from).map((message) => String(message.type)));
}

test('a monitor that names its broadcasts gets only those, and all of the audio', async () => {
  const server = await startRelay();
  const clients: RelayClient[] = [];
  try {
    const listen = await RelayClient.connect(server);
    const everything = await RelayClient.connect(server);
    clients.push(listen, everything);
    const listenFrom = await registerMonitor(listen, { broadcastTypes: ['session-status', 'source-status'] });
    const everythingFrom = await registerMonitor(everything);

    const backing = await RelayClient.connect(server);
    const publisher = await RelayClient.connect(server);
    clients.push(backing, publisher);
    backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
    await backing.waitForType('registered');
    publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await publisher.waitForType('registered');
    publisher.send({
      type: 'youtube-telemetry',
      videoId: 'dQw4w9WgXcQ',
      state: 1,
      currentTime: 42,
      duration: 200,
      playbackRate: 1,
    });

    const pcm = toInt16(pulseTrain(RATE, RATE, 5), 0.5);
    for (let start = 0; start + FRAME_SAMPLES <= pcm.length / 2; start += FRAME_SAMPLES) {
      backing.sendPcm(pcm.subarray(start * 2, (start + FRAME_SAMPLES) * 2));
      publisher.sendPcm(pcm.subarray(start * 2, (start + FRAME_SAMPLES) * 2));
      await sleep(20);
    }
    await sleep(300);

    const everythingTypes = typesSince(everything, everythingFrom);
    for (const type of ['source-status', 'publisher-status', 'youtube-timeline-status']) {
      assert.ok(everythingTypes.has(type), `a monitor that named nothing still gets ${type}`);
    }

    const listenTypes = typesSince(listen, listenFrom);
    assert.ok(listenTypes.has('source-status'), 'a named broadcast still arrives');
    assert.deepEqual(
      [...listenTypes].filter((type) => type !== 'session-status' && type !== 'source-status'),
      [],
      'no broadcast the monitor did not name, including publisher status on the monitor path',
    );

    assert.ok(listen.binaryFrames > 20, `the audio still arrives (${listen.binaryFrames} frames)`);
    assert.ok(
      Math.abs(listen.binaryFrames - everything.binaryFrames) <= 1,
      'filtering status never costs a monitor audio frames',
    );
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

test('a malformed broadcast list keeps every broadcast', () => {
  assert.equal(parseBroadcastTypes(undefined), undefined);
  assert.equal(parseBroadcastTypes('session-status'), undefined);
  assert.equal(parseBroadcastTypes(['session-status', 7]), undefined);
  assert.equal(parseBroadcastTypes(['']), undefined);
  assert.equal(parseBroadcastTypes(['x'.repeat(65)]), undefined);
  assert.equal(parseBroadcastTypes(Array.from({ length: 33 }, (_, index) => `type-${index}`)), undefined);
  assert.deepEqual([...parseBroadcastTypes(['session-status', 'source-status'])!], ['session-status', 'source-status']);
  assert.deepEqual([...parseBroadcastTypes([])!], []);
});

test('Listen names every broadcast type its monitor handler reads', async () => {
  const source = (await readFile(new URL('../public/listen.js', import.meta.url), 'utf8'))
    .replace(/\r\n/g, '\n');
  const declared = source.match(/const MONITOR_BROADCAST_TYPES = \[([^\]]*)\];/);
  assert.ok(declared, 'Listen must declare the broadcasts its monitor socket reads');
  const named = new Set([...declared[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));

  const start = source.indexOf('function handleMessage(message) {');
  const end = source.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, 'Listen keeps one monitor message handler');
  const handled = new Set(
    [...source.slice(start, end).matchAll(/message\.type === '([^']+)'/g)].map((match) => match[1]),
  );
  // `registered` answers this socket's own registration; it is never a broadcast.
  handled.delete('registered');

  for (const type of handled) {
    assert.ok(named.has(type), `Listen handles ${type} but never asks Relay for it`);
  }
  assert.match(
    source,
    /role: 'monitor',[\s\S]*broadcastTypes: MONITOR_BROADCAST_TYPES/,
    'Listen registers its monitor with that list',
  );
});
