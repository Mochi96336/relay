import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const PLAYING_TELEMETRY = {
  type: 'youtube-telemetry',
  videoId: 'dQw4w9WgXcQ',
  state: 1,
  currentTime: 42,
  duration: 200,
  playbackRate: 1,
};

/** Waits until Relay has handled everything this client sent so far. */
async function settled(client: RelayClient) {
  const from = client.messages.length;
  client.send({ type: 'product-status-request' });
  await client.waitFor(
    (message) => message.type === 'product-status' && client.messages.indexOf(message) >= from,
  );
  return client.messages.length;
}

function typesSince(client: RelayClient, from: number) {
  return new Set(client.messages.slice(from).map((message) => String(message.type)));
}

async function playingRoom(server: Awaited<ReturnType<typeof startRelay>>) {
  const backing = await RelayClient.connect(server);
  backing.send({ type: 'register', role: 'backing', sampleRate: RATE });
  await backing.waitForType('registered');
  const publisher = await RelayClient.connect(server);
  publisher.send({ type: 'register', role: 'publisher', sampleRate: RATE });
  await publisher.waitForType('registered');
  publisher.send(PLAYING_TELEMETRY);
  const silence = Buffer.alloc(1_920);
  for (let frame = 0; frame < 25; frame += 1) {
    backing.sendPcm(silence);
    publisher.sendPcm(silence);
    await sleep(20);
  }
  await sleep(300);
  return [backing, publisher];
}

test('a page socket that subscribes gets only the broadcasts it named', async () => {
  const server = await startRelay();
  const clients: RelayClient[] = [];
  try {
    const subscribed = await RelayClient.connect(server);
    const reset = await RelayClient.connect(server);
    const everything = await RelayClient.connect(server);
    clients.push(subscribed, reset, everything);
    subscribed.send({ type: 'broadcast-subscribe', types: ['source-status'] });
    reset.send({ type: 'broadcast-subscribe', types: ['source-status'] });
    reset.send({ type: 'broadcast-subscribe', types: 'source-status' });
    const subscribedFrom = await settled(subscribed);
    const resetFrom = await settled(reset);
    const everythingFrom = await settled(everything);

    clients.push(...await playingRoom(server));

    const everythingTypes = typesSince(everything, everythingFrom);
    for (const type of ['source-status', 'youtube-timeline-status']) {
      assert.ok(everythingTypes.has(type), `a socket that never subscribed still gets ${type}`);
    }
    const resetTypes = typesSince(reset, resetFrom);
    assert.ok(
      resetTypes.has('youtube-timeline-status'),
      'a malformed subscription goes back to every broadcast',
    );
    assert.deepEqual(
      [...typesSince(subscribed, subscribedFrom)],
      ['source-status'],
      'only the named broadcast reaches a subscribed socket',
    );

    // Replies addressed to the socket are not broadcasts and still arrive.
    const beforeReply = subscribed.messages.length;
    subscribed.send({ type: 'youtube-timeline-request' });
    await subscribed.waitFor(
      (message) => message.type === 'youtube-timeline-status'
        && subscribed.messages.indexOf(message) >= beforeReply,
    );
  } finally {
    for (const client of clients) client.close();
    await server.stop();
  }
});

type PageSubscription = {
  page: string;
  constant: string;
  handlerStart: string;
  handlerEnd: string;
};

const PAGES: PageSubscription[] = [
  {
    page: 'presence.js',
    constant: 'PRESENCE_BROADCAST_TYPES',
    handlerStart: 'function handleMessage(message) {',
    handlerEnd: 'function scheduleReconnect() {',
  },
  {
    page: 'live-status.js',
    constant: 'LIVE_STATUS_BROADCAST_TYPES',
    handlerStart: "next.addEventListener('message'",
    handlerEnd: "next.addEventListener('close'",
  },
  {
    page: 'timing-authority.js',
    constant: 'TIMING_AUTHORITY_BROADCAST_TYPES',
    handlerStart: 'function acceptSourceStatus(message) {',
    handlerEnd: 'function connect() {',
  },
  {
    page: 'youtube-sync.js',
    constant: 'YOUTUBE_SYNC_BROADCAST_TYPES',
    handlerStart: 'function handleServerMessage(message) {',
    handlerEnd: '// Every message type handleServerMessage reads',
  },
  {
    page: 'recorder.js',
    constant: 'RECORDER_BROADCAST_TYPES',
    handlerStart: "next.addEventListener('message'",
    handlerEnd: "next.addEventListener('close'",
  },
];

for (const { page, constant, handlerStart, handlerEnd } of PAGES) {
  test(`${page} subscribes to every message type its socket handler reads`, async () => {
    const source = (await readFile(new URL(`../public/${page}`, import.meta.url), 'utf8'))
      .replace(/\r\n/g, '\n');
    const declared = source.match(new RegExp(`const ${constant} = \\[([^\\]]*)\\];`));
    assert.ok(declared, `${page} must declare ${constant}`);
    const named = new Set([...declared[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));

    const start = source.indexOf(handlerStart);
    const end = source.indexOf(handlerEnd, start);
    assert.ok(start >= 0 && end > start, `${page} keeps one socket message handler`);
    const handled = new Set(
      [...source.slice(start, end).matchAll(/message\??\.type [!=]== '([^']+)'/g)].map((match) => match[1]),
    );
    assert.ok(handled.size > 0, `${page}: the handler's message types were not found`);
    for (const type of handled) {
      assert.ok(named.has(type), `${page} reads ${type} but never subscribes to it`);
    }
    assert.match(
      source,
      new RegExp(`type: 'broadcast-subscribe', types: ${constant}`),
      `${page} sends its subscription on every new socket`,
    );
  });
}
