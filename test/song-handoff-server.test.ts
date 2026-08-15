import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

function playbackQuery(participantId: string, name: string) {
  return `?participant=${participantId}&name=${encodeURIComponent(name)}`;
}

async function playback(
  server: Awaited<ReturnType<typeof startRelay>>,
  participantId: string,
  name: string,
  transportId: string,
  generation = 1,
) {
  const client = await RelayClient.connect(server, playbackQuery(participantId, name));
  client.send({ type: 'playback-hello', playbackTransportId: transportId, playbackGeneration: generation });
  const registered = await client.waitForType('playback-registered');
  assert.equal(registered.playbackTransportId, transportId);
  return client;
}

async function publisher(
  server: Awaited<ReturnType<typeof startRelay>>,
  participantId: string,
  name: string,
  takeoverExpectedOwnerId?: string,
) {
  const client = await RelayClient.connect(server, playbackQuery(participantId, name));
  const registration: Record<string, unknown> = {
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration: 1,
  };
  if (takeoverExpectedOwnerId !== undefined) {
    registration.takeoverExpectedOwnerId = takeoverExpectedOwnerId;
  }
  client.send(registration);
  await client.waitFor((message) => message.type === 'registered' && message.role === 'publisher');
  return client;
}

function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state: 1,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...overrides,
  };
}

test('mic takeover prepares the room song before switching playback leader', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'participant-a', 'A', 'playback-tab-a');
    const aPublisher = await publisher(server, 'participant-a', 'A');

    aPlayback.send(telemetry(10));
    await aPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
    ));

    const bPlayback = await playback(server, 'participant-b', 'B', 'playback-tab-b');
    await sleep(120);
    assert.equal(
      bPlayback.messages.some((message) => message.type === 'song-handoff-prepare'),
      false,
      'joining the room must not prepare or autoplay the current song',
    );

    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await publisher(server, 'participant-b', 'B', 'participant-a');

    const prepare = await bPlayback.waitForType('song-handoff-prepare');
    assert.equal(prepare.videoId, VIDEO);
    assert.equal(prepare.state, 1);
    assert.ok(Number.isFinite(Number(prepare.serverTime)));

    // Ownership already moved, but the room clock deliberately remains on A
    // until B has prepared the exact same song and acknowledged readiness.
    aPlayback.send(telemetry(Number(prepare.serverTime) + 0.05));
    await sleep(60);
    bPlayback.send(telemetry(Number(prepare.serverTime) + 0.08));
    await sleep(80);
    bPlayback.send({ type: 'youtube-timeline-request' });
    await sleep(40);
    assert.equal(bPlayback.latest('youtube-timeline-status')?.playbackLeaderParticipantId, 'participant-a');

    // The former singer may keep the existing playback moving for continuity,
    // but can no longer pause or seek the room while the handoff is pending.
    aPlayback.send(telemetry(Number(prepare.serverTime) + 0.1, { state: 2 }));
    await sleep(80);
    aPlayback.send({ type: 'youtube-timeline-request' });
    await sleep(40);
    assert.equal(aPlayback.latest('youtube-timeline-status')?.state, 1);

    bPlayback.send({ type: 'song-handoff-ready', handoffId: prepare.handoffId });
    const commit = await bPlayback.waitForType('song-handoff-commit');
    assert.equal(commit.handoffId, prepare.handoffId);
    assert.equal(commit.videoId, VIDEO);

    bPlayback.send(telemetry(Number(commit.serverTime) + 0.05));
    const switched = await bPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-b'
      && message.handoffState === 'idle'
    ));
    assert.equal(switched.playbackTransportId, 'playback-tab-b');

    const release = await aPlayback.waitForType('song-handoff-release');
    assert.equal(release.handoffId, prepare.handoffId);
    assert.equal(release.videoId, VIDEO);
    assert.equal((await bPlayback.waitForType('song-handoff-complete')).handoffId, prepare.handoffId);

    bPlayback.send({ type: 'room-song-status-request' });
    const room = await bPlayback.waitFor((message) => (
      message.type === 'room-song-status'
      && message.handoffState === 'idle'
      && message.videoId === VIDEO
    ));
    assert.equal(room.state, 1);

    aPlayback.close();
    aPublisher.close();
    bPlayback.close();
    bPublisher.close();
  } finally {
    await server.stop();
  }
});

test('multi-tab Mic takeover targets only the playback transport that expressed intent', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'participant-a', 'A', 'playback-tab-a');
    const aPublisher = await publisher(server, 'participant-a', 'A');
    aPlayback.send(telemetry(20));
    await aPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
    ));

    const bOtherTab = await playback(server, 'participant-b', 'B', 'playback-tab-b-other');
    const bMicTab = await playback(server, 'participant-b', 'B', 'playback-tab-b-mic');

    bMicTab.send({ type: 'playback-mic-intent' });
    await bMicTab.waitForType('playback-mic-intent-registered');
    const bPublisher = await publisher(server, 'participant-b', 'B', 'participant-a');

    const prepare = await bMicTab.waitForType('song-handoff-prepare');
    assert.equal(prepare.videoId, VIDEO);
    await sleep(120);
    assert.equal(
      bOtherTab.messages.some((message) => message.type === 'song-handoff-prepare'),
      false,
      'another live tab from the same person must not receive the handoff',
    );

    bOtherTab.send(telemetry(Number(prepare.serverTime) + 0.05));
    await sleep(80);
    bOtherTab.send({ type: 'youtube-timeline-request' });
    await sleep(40);
    assert.equal(
      bOtherTab.latest('youtube-timeline-status')?.playbackLeaderParticipantId,
      'participant-a',
      'the non-target tab cannot become leader by sending telemetry',
    );

    aPlayback.close();
    aPublisher.close();
    bOtherTab.close();
    bMicTab.close();
    bPublisher.close();
  } finally {
    await server.stop();
  }
});
