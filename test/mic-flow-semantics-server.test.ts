import assert from 'node:assert/strict';
import test from 'node:test';

import { encodePcmFrame } from '../src/pcm-frame.js';
import { participantIdFor, RelayClient, sleep, startRelay } from './helpers/harness.js';
import { registerPlayback, requestProductStatus } from './support/client-commands.js';

const RATE = 48_000;
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_CALIBRATION_PROBE: '0',
  RELAY_MIC_TRANSPORT_GRACE_MS: '500',
};

function pcm(ms = 40) {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * 2);
}

test('Mic state distinguishes starting, flowing, stalled and reconnecting', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connectAs(server, 'observer-state', 'Observer');
    const singer = await RelayClient.connectAs(server, 'singer-state', 'Singer');
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await singer.waitForType('registered');

    const starting = await requestProductStatus(
      observer,
      (message) => message.room?.mic?.ownerId === participantIdFor('singer-state'),
    );
    assert.equal(starting.room.mic.state, 'starting');
    assert.equal(starting.health, 'healthy');
    assert.equal(starting.attention, null);

    singer.sendPcm(pcm());
    await sleep(40);
    const live = await requestProductStatus(observer, (message) => message.room?.mic?.state === 'live');
    assert.equal(live.lifecycle, 'live');
    assert.equal(live.health, 'healthy');

    await sleep(1_100);
    const interrupted = await requestProductStatus(
      observer,
      (message) => message.room?.mic?.state === 'interrupted',
    );
    assert.equal(interrupted.health, 'degraded');
    assert.equal(interrupted.attention?.code, 'mic-audio-stalled');

    singer.close();
    await sleep(40);
    const reconnecting = await requestProductStatus(
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

test('replayed legacy Mic PCM cannot keep streaming freshness alive', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connectAs(server, 'observer-replay', 'Observer');
    const singer = await RelayClient.connectAs(server, 'singer-replay', 'Singer');
    singer.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await singer.waitForType('registered');

    const first = pcm();
    singer.sendPcm(first);
    await sleep(40);
    await requestProductStatus(observer, (message) => message.room?.mic?.state === 'live');

    const replay = encodePcmFrame(singer.generationId, 0, first);
    const replayTimer = setInterval(() => singer.sendBinary(replay), 100);
    try {
      await sleep(1_150);
    } finally {
      clearInterval(replayTimer);
    }

    const interrupted = await requestProductStatus(
      observer,
      (message) => message.room?.mic?.state === 'interrupted',
    );
    assert.equal(interrupted.attention?.code, 'mic-audio-stalled');

    singer.close();
    observer.close();
  } finally {
    await server.stop();
  }
});

test('a new Mic owner cannot inherit the previous capture freshness', async () => {
  const server = await startRelay(FAST);
  try {
    const observer = await RelayClient.connectAs(server, 'observer-takeover', 'Observer');
    const alice = await RelayClient.connectAs(server, 'participant-alice', 'Alice');
    alice.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await alice.waitForType('registered');
    alice.sendPcm(pcm());
    await sleep(40);
    await requestProductStatus(observer, (message) => message.room?.mic?.state === 'live');

    const bob = await RelayClient.connectAs(server, 'participant-bobby', 'Bob');
    bob.send({
      type: 'register',
      role: 'publisher',
      sampleRate: RATE,
      takeoverExpectedOwnerId: participantIdFor('participant-alice'),
    });
    await bob.waitFor((message) => message.type === 'registered' && message.takeover === true);

    const beforeBobAudio = await requestProductStatus(
      observer,
      (message) => message.room?.mic?.ownerId === participantIdFor('participant-bobby'),
    );
    assert.equal(beforeBobAudio.room.mic.state, 'starting');

    bob.sendPcm(pcm());
    await sleep(40);
    const afterBobAudio = await requestProductStatus(
      observer,
      (message) => (
        message.room?.mic?.ownerId === participantIdFor('participant-bobby')
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
    const playback = await RelayClient.connectAs(server, 'song-singer', 'Singer');
    const observer = await RelayClient.connectAs(server, 'song-observer', 'Observer');
    playback.send({ type: 'register', role: 'publisher', sampleRate: RATE });
    await playback.waitForType('registered');
    await registerPlayback(playback, 'song-playback');
    playback.send({
      type: 'room-song-command',
      commandId: 'song-load',
      expectedRevision: 0,
      action: 'load',
      videoId: 'dQw4w9WgXcQ',
      positionSeconds: 12,
    });
    await playback.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'song-load');
    playback.send({
      type: 'youtube-telemetry',
      videoId: 'dQw4w9WgXcQ',
      state: 5,
      currentTime: 12,
      duration: 200,
      playbackRate: 1,
      bufferedFraction: 0.5,
      playbackTransportId: 'song-playback',
      playbackGeneration: 1,
    });
    await observer.waitFor(
      (message) => message.type === 'youtube-timeline-status' && message.videoId === 'dQw4w9WgXcQ',
    );

    const readyResponse = await fetch(server.httpUrl('/readyz'));
    assert.equal(readyResponse.status, 503);
    const readiness = await readyResponse.json() as any;
    assert.equal(readiness.components.route.mode, 'song');
    assert.ok(readiness.reasons.includes('backing-not-connected'));

    const product = await requestProductStatus(
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
