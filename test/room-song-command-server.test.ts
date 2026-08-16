import assert from 'node:assert/strict';
import test from 'node:test';

import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const VIDEO = 'dQw4w9WgXcQ';

function telemetry(
  currentTime: number,
  state: number,
  transportId: string,
  generation = 1,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'youtube-telemetry',
    videoId: VIDEO,
    state,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.7,
    playbackTransportId: transportId,
    playbackGeneration: generation,
    ...overrides,
  };
}

async function registerPlayback(client: RelayClient, transportId: string, generation = 1) {
  client.send({
    type: 'playback-hello',
    playbackTransportId: transportId,
    playbackGeneration: generation,
  });
  await client.waitFor((message) => (
    message.type === 'playback-registered'
    && message.playbackTransportId === transportId
    && message.playbackGeneration === generation
  ));
}

async function loadRoomSong(
  client: RelayClient,
  transportId: string,
  expectedRevision = 0,
  commandId = 'command-load-1',
) {
  client.send({
    type: 'room-song-command',
    commandId,
    expectedRevision,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: 0,
  });
  const accepted = await client.waitFor((message) => (
    message.type === 'room-song-command-accepted' && message.commandId === commandId
  ));
  const apply = await client.waitFor((message) => (
    message.type === 'room-song-command-apply' && message.commandId === commandId
  ));
  assert.equal(apply.targetPlaybackTransportId, transportId);

  client.send(telemetry(0, 5, transportId));
  await client.waitFor((message) => (
    message.type === 'room-song-command-complete' && message.commandId === commandId
  ));
  return Number(accepted.revision);
}

test('room song changes are accepted, targeted and completed through one command path', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const transport = 'playback-command-a';
    await registerPlayback(a, transport);

    const revision1 = await loadRoomSong(a, transport);
    assert.equal(revision1, 1);

    const room = await a.waitFor((message) => (
      message.type === 'room-song-status' && message.videoId === VIDEO
    ));
    assert.equal(room.state, 5);

    a.send({
      type: 'room-song-command',
      commandId: 'command-play-1',
      expectedRevision: revision1,
      action: 'play',
    });
    const playAccepted = await a.waitFor((message) => (
      message.type === 'room-song-command-accepted' && message.commandId === 'command-play-1'
    ));
    assert.equal(playAccepted.revision, 2);
    await a.waitFor((message) => (
      message.type === 'room-song-command-apply'
      && message.commandId === 'command-play-1'
      && message.action === 'play'
    ));

    a.send(telemetry(0.2, 1, transport));
    await a.waitFor((message) => (
      message.type === 'room-song-command-complete' && message.commandId === 'command-play-1'
    ));

    a.send({ type: 'room-song-command-status-request' });
    const status = await a.waitFor((message) => (
      message.type === 'room-song-command-status'
      && message.revision === 2
      && message.pendingCommandId === null
    ));
    assert.equal(status.pendingAction, null);
  } finally {
    await server.stop();
  }
});

test('identified telemetry cannot mutate the room without an accepted command', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const transport = 'playback-direct-a';
    await registerPlayback(a, transport);

    a.send(telemetry(30, 1, transport));
    const rejected = await a.waitFor((message) => message.type === 'room-song-telemetry-rejected');
    assert.equal(rejected.reason, 'command-required');

    a.send({ type: 'youtube-timeline-request' });
    await sleep(50);
    const timeline = a.latest('youtube-timeline-status');
    assert.ok(timeline);
    assert.equal(timeline.videoId, undefined);
    assert.equal(timeline.playbackLeaderParticipantId, null);
  } finally {
    await server.stop();
  }
});

test('Mic owner authority and exact playback target both apply to room song commands', async () => {
  const server = await startRelay();
  try {
    const owner = await RelayClient.connect(server, '?participant=participant-owner&name=Owner');
    const sibling = await RelayClient.connect(server, '?participant=participant-owner&name=Owner');
    const other = await RelayClient.connect(server, '?participant=participant-other&name=Other');
    const ownerTransport = 'playback-owner-1';
    const siblingTransport = 'playback-owner-2';
    const otherTransport = 'playback-other-1';

    await registerPlayback(owner, ownerTransport);
    await registerPlayback(sibling, siblingTransport);
    await registerPlayback(other, otherTransport);

    owner.send({ type: 'register', role: 'publisher', sampleRate: 48_000, captureGeneration: 1 });
    await owner.waitFor((message) => message.type === 'registered' && message.role === 'publisher');

    const revision1 = await loadRoomSong(owner, ownerTransport);

    other.send({
      type: 'room-song-command',
      commandId: 'command-other-1',
      expectedRevision: revision1,
      action: 'play',
    });
    const nonOwner = await other.waitFor((message) => (
      message.type === 'room-song-command-rejected' && message.commandId === 'command-other-1'
    ));
    assert.equal(nonOwner.reason, 'mic-owner-required');

    sibling.send({
      type: 'room-song-command',
      commandId: 'command-sibling-1',
      expectedRevision: revision1,
      action: 'play',
    });
    const wrongTab = await sibling.waitFor((message) => (
      message.type === 'room-song-command-rejected' && message.commandId === 'command-sibling-1'
    ));
    assert.equal(wrongTab.reason, 'playback-leader-required');
  } finally {
    await server.stop();
  }
});

test('stale revisions and concurrent pending intents are rejected without replacing 1A intent', async () => {
  const server = await startRelay();
  try {
    const a = await RelayClient.connect(server, '?participant=participant-a&name=A');
    const transport = 'playback-serial-a';
    await registerPlayback(a, transport);
    const revision1 = await loadRoomSong(a, transport);

    a.send({
      type: 'room-song-command',
      commandId: 'command-stale-1',
      expectedRevision: 0,
      action: 'play',
    });
    const stale = await a.waitFor((message) => (
      message.type === 'room-song-command-rejected' && message.commandId === 'command-stale-1'
    ));
    assert.equal(stale.reason, 'stale-revision');
    assert.equal(stale.revision, revision1);

    a.send({
      type: 'room-song-command',
      commandId: 'command-play-2',
      expectedRevision: revision1,
      action: 'play',
    });
    const accepted = await a.waitFor((message) => (
      message.type === 'room-song-command-accepted' && message.commandId === 'command-play-2'
    ));
    assert.equal(accepted.revision, 2);

    a.send({
      type: 'room-song-command',
      commandId: 'command-seek-2',
      expectedRevision: 2,
      action: 'seek',
      positionSeconds: 40,
    });
    const pending = await a.waitFor((message) => (
      message.type === 'room-song-command-rejected' && message.commandId === 'command-seek-2'
    ));
    assert.equal(pending.reason, 'command-pending');
  } finally {
    await server.stop();
  }
});
