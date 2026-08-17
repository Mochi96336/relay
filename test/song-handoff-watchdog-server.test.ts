import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, startRelay } from './helpers/harness.js';

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
) {
  const client = await RelayClient.connect(server, playbackQuery(participantId, name));
  client.send({ type: 'playback-hello', playbackTransportId: transportId, playbackGeneration: 1 });
  await client.waitForType('playback-registered');
  return client;
}

async function publisher(
  server: Awaited<ReturnType<typeof startRelay>>,
  participantId: string,
  name: string,
  takeoverExpectedOwnerId?: string,
) {
  const client = await RelayClient.connect(server, playbackQuery(participantId, name));
  client.send({
    type: 'register',
    role: 'publisher',
    sampleRate: RATE,
    captureGeneration: 1,
    ...(takeoverExpectedOwnerId !== undefined ? { takeoverExpectedOwnerId } : {}),
  });
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

async function establishPlayingRoom(client: RelayClient, currentTime: number) {
  client.send({
    type: 'room-song-command',
    commandId: 'watchdog-load',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: currentTime,
  });
  await client.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'watchdog-load');
  client.send(telemetry(currentTime, { state: 5 }));
  await client.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'watchdog-load');

  client.send({
    type: 'room-song-command',
    commandId: 'watchdog-play',
    expectedRevision: 1,
    action: 'play',
  });
  await client.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === 'watchdog-play');
  client.send(telemetry(currentTime + 0.05));
  await client.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === 'watchdog-play');
}

test('server cancels a stuck commit without depending on the target client watchdog', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'participant-a', 'A', 'playback-tab-a');
    const aPublisher = await publisher(server, 'participant-a', 'A');
    await establishPlayingRoom(aPlayback, 10);

    const bPlayback = await playback(server, 'participant-b', 'B', 'playback-tab-b');
    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await publisher(server, 'participant-b', 'B', 'participant-a');

    const prepare = await bPlayback.waitForType('song-handoff-prepare');
    bPlayback.send({ type: 'song-handoff-ready', handoffId: prepare.handoffId });
    const commit = await bPlayback.waitForType('song-handoff-commit');
    assert.equal(commit.handoffId, prepare.handoffId);

    // Do not send target playback telemetry and do not send song-handoff-failed.
    // The server's own 5 s commit deadline must be sufficient to escape.
    const cancelled = await bPlayback.waitForType('song-handoff-cancelled', 7_000);
    assert.equal(cancelled.type, 'song-handoff-cancelled');

    aPlayback.send({ type: 'youtube-timeline-request' });
    const status = await aPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.handoffState === 'idle'
      && message.playbackLeaderParticipantId === 'participant-a'
    ));
    assert.equal(status.playbackTransportId, 'playback-tab-a');

    // Failed-handoff holdover is deliberately narrow: A may keep the existing
    // playing song continuous after Mic ownership already moved to B.
    aPlayback.send(telemetry(Number(status.serverTime)));
    const continued = await aPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === 'participant-a'
      && message.handoffState === 'idle'
      && Number(message.ageMs) < 1_000
    ));
    assert.equal(continued.state, 1);

    aPlayback.close();
    aPublisher.close();
    bPlayback.close();
    bPublisher.close();
  } finally {
    await server.stop();
  }
});
