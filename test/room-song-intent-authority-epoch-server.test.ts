import assert from 'node:assert/strict';
import test from 'node:test';

import { participantIdFor, RelayClient, startRelay } from './helpers/harness.js';
import { youtubeTelemetry } from './support/youtube-telemetry.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

const A_ID = participantIdFor('A');
const B_ID = participantIdFor('B');

async function playback(
  server: Awaited<ReturnType<typeof startRelay>>,
  name: string,
  transportId: string,
) {
  const client = await RelayClient.connectAs(server, name);
  client.send({ type: 'playback-hello', playbackTransportId: transportId, playbackGeneration: 1 });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
  ));
  return client;
}

async function publisher(
  server: Awaited<ReturnType<typeof startRelay>>,
  name: string,
  takeoverExpectedOwnerId?: string,
) {
  const client = await RelayClient.connectAs(server, name);
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

function telemetry(currentTime: number, state = 1) {
  return { type: 'youtube-telemetry', ...youtubeTelemetry({ state, currentTime }) };
}

async function establishPlayingRoom(client: RelayClient, currentTime = 10) {
  client.send({
    type: 'room-song-command',
    commandId: 'epoch-base-load',
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: currentTime,
  });
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply'
    && message.commandId === 'epoch-base-load'
  ));
  client.send(telemetry(currentTime, 5));
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete'
    && message.commandId === 'epoch-base-load'
  ));

  client.send({
    type: 'room-song-command',
    commandId: 'epoch-base-play',
    expectedRevision: 1,
    action: 'play',
  });
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply'
    && message.commandId === 'epoch-base-play'
  ));
  client.send(telemetry(currentTime + 0.05, 1));
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete'
    && message.commandId === 'epoch-base-play'
  ));
}

async function leavePendingSeek(client: RelayClient) {
  client.send({
    type: 'room-song-command',
    commandId: 'epoch-pending-seek',
    expectedRevision: 2,
    action: 'seek',
    positionSeconds: 30,
  });
  const accepted = await client.waitFor((message) => (
    message.type === 'room-song-command-accepted'
    && message.commandId === 'epoch-pending-seek'
  ));
  assert.equal(accepted.revision, 3);
  await client.waitFor((message) => (
    message.type === 'room-song-command-apply'
    && message.commandId === 'epoch-pending-seek'
  ));
}

test('Mic takeover terminates the prior owner intent before prepared playback handoff', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'A', 'playback-epoch-a');
    const aPublisher = await publisher(server, 'A');
    await establishPlayingRoom(aPlayback);
    await leavePendingSeek(aPlayback);

    const bPlayback = await playback(server, 'B', 'playback-epoch-b');
    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await publisher(server, 'B', A_ID);

    const cancelled = await aPlayback.waitFor((message) => (
      message.type === 'room-song-command-failed-ack'
      && message.commandId === 'epoch-pending-seek'
    ));
    assert.equal(cancelled.reason, 'mic-owner-changed');
    assert.equal(cancelled.revision, 3);

    const prepare = await bPlayback.waitForType('song-handoff-prepare');
    bPlayback.send({ type: 'song-handoff-ready', handoffId: prepare.handoffId });
    const commit = await bPlayback.waitForType('song-handoff-commit');

    bPlayback.send(telemetry(Number(commit.serverTime) + 0.05, Number(commit.state)));
    const switched = await bPlayback.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === B_ID
      && message.handoffState === 'idle'
    ));
    assert.equal(switched.playbackTransportId, 'playback-epoch-b');
    assert.equal(
      bPlayback.messages.some((message) => (
        message.type === 'room-song-telemetry-rejected'
        && message.reason === 'command-target-mismatch'
      )),
      false,
      'the prior owner command must not block the new handoff target telemetry',
    );

    bPlayback.send({ type: 'room-song-command-status-request' });
    const status = await bPlayback.waitFor((message) => (
      message.type === 'room-song-command-status'
      && message.revision === 3
      && message.pendingCommandId === null
    ));
    assert.equal(status.pendingAction, null);

    aPlayback.close();
    aPublisher.close();
    bPlayback.close();
    bPublisher.close();
  } finally {
    await server.stop();
  }
});

test('explicit Mic release terminates pending intent and late proof cannot resurrect it', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'A', 'playback-release-a');
    const aPublisher = await publisher(server, 'A');
    await establishPlayingRoom(aPlayback);
    await leavePendingSeek(aPlayback);

    aPlayback.send({ type: 'release-mic' });
    const cancelled = await aPlayback.waitFor((message) => (
      message.type === 'room-song-command-failed-ack'
      && message.commandId === 'epoch-pending-seek'
    ));
    assert.equal(cancelled.reason, 'mic-owner-released');
    await aPlayback.waitForType('mic-released');

    aPlayback.send(telemetry(30, 1));
    const rejected = await aPlayback.waitFor((message) => (
      message.type === 'room-song-telemetry-rejected'
      && message.revision === 3
    ));
    assert.equal(rejected.reason, 'command-required');

    aPlayback.send({ type: 'room-song-command-status-request' });
    const status = await aPlayback.waitFor((message) => (
      message.type === 'room-song-command-status'
      && message.revision === 3
      && message.pendingCommandId === null
    ));
    assert.equal(status.pendingAction, null);

    aPlayback.close();
    aPublisher.close();
  } finally {
    await server.stop();
  }
});
