import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_HEARTBEAT_MS: '60000',
  RELAY_MIC_TRANSPORT_GRACE_MS: '500',
};

function pcm(ms = 40) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

async function waitForNewMessage(
  client: RelayClient,
  startIndex: number,
  predicate: (message: Record<string, any>) => boolean,
  timeoutMs = 3_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = client.messages.slice(startIndex).find(predicate);
    if (found) return found;
    await sleep(10);
  }
  throw new Error(
    `Timed out waiting for new message; saw ${client.messages.slice(startIndex).map((message) => message.type).join(', ')}`,
  );
}

async function requestProduct(
  client: RelayClient,
  predicate: (message: Record<string, any>) => boolean,
) {
  const start = client.messages.length;
  client.send({ type: 'product-status-request' });
  return waitForNewMessage(
    client,
    start,
    (message) => message.type === 'product-status' && predicate(message),
  );
}

test('Mic state distinguishes starting, flowing, stalled and reconnecting', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connect(server, '?participant=observer-state&name=Observer');
    const singer = await RelayClient.connect(server, '?participant=singer-state&name=Singer');
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await singer.waitForType('registered');

    const starting = await requestProduct(
      observer,
      (message) => message.room?.mic?.ownerId === 'singer-state',
    );
    assert.equal(starting.room.mic.state, 'starting');
    assert.equal(starting.health, 'healthy');
    assert.equal(starting.attention, null);

    singer.sendPcm(pcm());
    await sleep(40);
    const live = await requestProduct(observer, (message) => message.room?.mic?.state === 'live');
    assert.equal(live.lifecycle, 'live');
    assert.equal(live.health, 'healthy');

    await sleep(1_100);
    const interrupted = await requestProduct(
      observer,
      (message) => message.room?.mic?.state === 'interrupted',
    );
    assert.equal(interrupted.health, 'degraded');
    assert.equal(interrupted.attention?.code, 'mic-audio-stalled');

    singer.close();
    await sleep(40);
    const reconnecting = await requestProduct(
      observer,
      (message) => message.room?.mic?.state === 'reconnecting',
    );
    assert.equal(reconnecting.health, 'degraded');
    assert.equal(reconnecting.attention?.code, 'mic-reconnecting');

    observer.close();
  } finally {
    await server.stop();
  }
});

test('a new Mic owner cannot inherit the previous capture freshness', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connect(server, '?participant=observer-takeover&name=Observer');
    const alice = await RelayClient.connect(server, '?participant=participant-alice&name=Alice');
    alice.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await alice.waitForType('registered');
    alice.sendPcm(pcm());
    await sleep(40);
    await requestProduct(observer, (message) => message.room?.mic?.state === 'live');

    const bob = await RelayClient.connect(server, '?participant=participant-bobby&name=Bob');
    bob.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      takeoverExpectedOwnerId: 'participant-alice',
    });
    await bob.waitFor((message) => message.type === 'registered' && message.takeover === true);

    const beforeBobAudio = await requestProduct(
      observer,
      (message) => message.room?.mic?.ownerId === 'participant-bobby',
    );
    assert.equal(beforeBobAudio.room.mic.state, 'starting');

    bob.sendPcm(pcm());
    await sleep(40);
    const afterBobAudio = await requestProduct(
      observer,
      (message) => (
        message.room?.mic?.ownerId === 'participant-bobby'
        && message.room?.mic?.state === 'live'
      ),
    );
    assert.equal(afterBobAudio.room.mic.state, 'live');

    bob.close();
    observer.close();
  } finally {
    await server.stop();
  }
});

test('a room Song makes backing expected instead of silently becoming voice-only', async () => {
  const server = await startRelay(FAST);
  try {
    const playback = await RelayClient.connect(server);
    const observer = await RelayClient.connect(server, '?participant=song-observer&name=Observer');
    playback.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await playback.waitForType('registered');
    playback.send({
      type: 'youtube-telemetry',
      videoId: 'dQw4w9WgXcQ',
      state: 1,
      currentTime: 12,
      duration: 200,
      playbackRate: 1,
      bufferedFraction: 0.5,
    });
    await observer.waitFor(
      (message) => message.type === 'youtube-timeline-status' && message.videoId === 'dQw4w9WgXcQ',
    );

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'song');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const product = await requestProduct(
      observer,
      (message) => message.room?.song?.videoId === 'dQw4w9WgXcQ',
    );
    assert.equal(product.health, 'blocked');
    assert.equal(product.attention?.code, 'audio-unavailable');

    playback.close();
    observer.close();
  } finally {
    await server.stop();
  }
});
