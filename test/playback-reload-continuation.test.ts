import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';
import { SongSession } from '../src/song-session.js';
import { RelayClient, sleep, startRelay } from './helpers/harness.js';

const RATE = 48_000;
const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
  RELAY_HEARTBEAT_MS: '60000',
};

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 10 };
const A_RELOAD = { ...A, generation: 11 };
const A_OTHER_TAB = { participantId: A.participantId, transportId: 'playback-tab-other', generation: 99 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 20 };
const B_RELOAD = { ...B, generation: 21 };

function room(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    serverTime: 12,
    youtubeTime: 12,
    ageMs: 0,
    playbackRate: 1,
    connected: true,
    leaderConnected: true,
    leaderFresh: true,
    playbackLeaderParticipantId: A.participantId,
    playbackTransportId: A.transportId,
    playbackGeneration: A.generation,
    handoffState: 'idle',
    ...overrides,
  };
}

function telemetry(currentTime = 12, overrides: Record<string, unknown> = {}) {
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

function query(participantId: string, name: string) {
  return `?participant=${participantId}&name=${encodeURIComponent(name)}`;
}

async function playback(
  server: Awaited<ReturnType<typeof startRelay>>,
  identity: { participantId: string; transportId: string; generation: number },
  name: string,
) {
  const client = await RelayClient.connect(server, query(identity.participantId, name));
  client.send({
    type: 'playback-hello',
    playbackTransportId: identity.transportId,
    playbackGeneration: identity.generation,
  });
  await client.waitForType('playback-registered');
  return client;
}

async function publisher(
  server: Awaited<ReturnType<typeof startRelay>>,
  participantId: string,
  name: string,
  takeoverExpectedOwnerId?: string,
) {
  const client = await RelayClient.connect(server, query(participantId, name));
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

async function establishRoom(client: RelayClient, prefix: string) {
  const loadId = `${prefix}-load`;
  client.send({
    type: 'room-song-command',
    commandId: loadId,
    expectedRevision: 0,
    action: 'load',
    videoId: VIDEO,
    positionSeconds: 10,
  });
  await client.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === loadId);
  client.send(telemetry(10, { state: 5 }));
  await client.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === loadId);

  const playId = `${prefix}-play`;
  client.send({ type: 'room-song-command', commandId: playId, expectedRevision: 1, action: 'play' });
  await client.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === playId);
  client.send(telemetry(10.05));
  await client.waitFor((message) => message.type === 'room-song-command-complete' && message.commandId === playId);
}

test('reload bootstrap waits for YouTube readiness and suppresses transient iframe telemetry', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const readyStart = source.indexOf('function handleReady');
  const readyEnd = source.indexOf('function handleStateChange', readyStart);
  const ready = source.slice(readyStart, readyEnd);
  assert.match(ready, /serverMutation\?\.source === 'restore'/);
  assert.match(ready, /applyAuthoritativeRestore\(\)/);

  const renderStart = source.indexOf('function renderSnapshot');
  const renderEnd = source.indexOf('function sampleNow', renderStart);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /mutationContext\?\.source === 'restore'/);
  assert.match(render, /!snapshotMatchesDesired\(snapshot, mutationContext\)/);

  const viewStart = source.indexOf("window.addEventListener('relay:playback-view'");
  const viewEnd = source.indexOf("window.addEventListener('relay:recover-room-song'", viewStart);
  const view = source.slice(viewStart, viewEnd);
  const restoreIndex = view.indexOf('restoreAuthoritativeRoom(detail.room)');
  const sameRoleIndex = view.indexOf('if (nextRole === playbackRole) return');
  assert.ok(restoreIndex >= 0 && sameRoleIndex > restoreIndex, 'same-role status updates must not hide reload bootstrap');
  assert.match(view, /currentGeneration > leaderGeneration/);
  assert.match(view, /currentGeneration === leaderGeneration/);
});

test('new generation supersedes only an older pending command on the same logical transport', () => {
  const commands = new RoomSongCommandSession();
  const parsed = parseRoomSongCommand({
    commandId: 'command-play-reload',
    expectedRevision: 0,
    action: 'play',
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const begun = commands.begin(
    parsed.request,
    A.participantId,
    A,
    A.participantId,
    room({ state: 2 }),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);
  assert.equal(commands.pendingForTarget(A, 1)?.commandId, 'command-play-reload');
  assert.equal(commands.pendingForTarget(A_OTHER_TAB, 2), null);
  assert.equal(commands.statusPayload(1, 2).pendingCommandId, 'command-play-reload');

  assert.equal(commands.pendingForTarget(A_RELOAD, 3), null);
  assert.equal(commands.statusPayload(1, 3).pendingCommandId, null);
});

test('a prepared handoff follows a reloaded incarnation of the same tab, but not another tab', () => {
  const songs = new SongSession();
  assert.equal(songs.update(telemetry(), A, null, 0).accepted, true);

  const first = songs.beginHandoff(B, B.participantId, 100);
  assert.ok(first);
  assert.deepEqual(first?.target, B);

  const otherTab = songs.handoffPlanForTarget({ ...B, transportId: 'playback-tab-b-other', generation: 99 }, 105);
  assert.equal(otherTab, null);

  const resumed = songs.handoffPlanForTarget(B_RELOAD, 110);
  assert.ok(resumed);
  assert.notEqual(resumed?.handoffId, first?.handoffId);
  assert.deepEqual(resumed?.target, B_RELOAD);
  assert.equal(songs.statusPayload(110).handoffTargetPlaybackGeneration, B_RELOAD.generation);
  assert.equal(songs.statusPayload(110).handoffState, 'preparing');
});

test('Mic takeover can continue through a reload of its prepared playback tab', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, A, 'A');
    const aPublisher = await publisher(server, A.participantId, 'A');
    await establishRoom(aPlayback, 'reload-handoff');

    const bPlayback = await playback(server, B, 'B');
    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await publisher(server, B.participantId, 'B', A.participantId);

    const firstPrepare = await bPlayback.waitForType('song-handoff-prepare');
    assert.equal(firstPrepare.videoId, VIDEO);

    // Browser reload overlap: the new incarnation can say hello before the old
    // websocket has fully closed. The same sessionStorage transport ID plus a
    // newer generation must resume the prepared handoff rather than becoming a
    // sibling tab or leaving the room frozen behind the old generation.
    const bReloaded = await playback(server, B_RELOAD, 'B');
    const resumedPrepare = await bReloaded.waitForType('song-handoff-prepare');
    assert.notEqual(resumedPrepare.handoffId, firstPrepare.handoffId);
    assert.equal(resumedPrepare.videoId, VIDEO);
    bPlayback.close();

    bReloaded.send({ type: 'song-handoff-ready', handoffId: resumedPrepare.handoffId });
    const commit = await bReloaded.waitForType('song-handoff-commit');
    bReloaded.send(telemetry(Number(commit.serverTime) + 0.05));

    const switched = await bReloaded.waitFor((message) => (
      message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === B.participantId
      && message.playbackTransportId === B.transportId
      && Number(message.playbackGeneration) === B_RELOAD.generation
      && message.handoffState === 'idle'
    ));
    assert.equal(switched.playbackGeneration, B_RELOAD.generation);

    aPlayback.close();
    aPublisher.close();
    bPublisher.close();
    bReloaded.close();
  } finally {
    await server.stop();
  }
});

test('reload hello clears an old-generation command without waiting for command timeout', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, A, 'A');
    const aPublisher = await publisher(server, A.participantId, 'A');
    await establishRoom(aPlayback, 'reload-command');

    const pendingId = 'reload-command-pause';
    aPlayback.send({ type: 'room-song-command', commandId: pendingId, expectedRevision: 2, action: 'pause' });
    await aPlayback.waitFor((message) => message.type === 'room-song-command-apply' && message.commandId === pendingId);

    const reloaded = await playback(server, A_RELOAD, 'A');
    reloaded.send({ type: 'room-song-command-status-request' });
    const converged = await reloaded.waitFor((message) => (
      message.type === 'room-song-command-status'
      && Number(message.revision) === 3
      && message.pendingCommandId === null
    ));
    assert.equal(converged.pendingCommandId, null);

    // The newer page may issue the next intent immediately at the already
    // accepted room-command revision; it does not sit behind a four-second
    // command-pending tombstone from the page that was reloaded.
    const nextId = 'reload-command-play';
    reloaded.send({ type: 'room-song-command', commandId: nextId, expectedRevision: 3, action: 'play' });
    const accepted = await reloaded.waitFor((message) => (
      message.type === 'room-song-command-accepted' && message.commandId === nextId
    ));
    assert.equal(accepted.commandId, nextId);

    aPlayback.close();
    aPublisher.close();
    reloaded.close();
  } finally {
    await server.stop();
  }
});
