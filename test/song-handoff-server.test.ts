import assert from 'node:assert/strict';
import test from 'node:test';

import { participantIdFor, RelayClient, sleep, startRelay } from './helpers/harness.js';
import { micPublisher, playRoomSong, registerPlayback } from './support/client-commands.js';
import { youtubeTelemetry } from './support/youtube-telemetry.js';

const VIDEO = 'dQw4w9WgXcQ';
const FAST = {
  RELAY_AUTO_CALIBRATE: '0',
};

const A_ID = participantIdFor('A');
const B_ID = participantIdFor('B');

async function playback(
  server: Awaited<ReturnType<typeof startRelay>>,
  name: string,
  transportId: string,
  generation = 1,
) {
  const client = await RelayClient.connectAs(server, name);
  await registerPlayback(client, transportId, generation);
  return client;
}

function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return { type: 'youtube-telemetry', ...youtubeTelemetry({ currentTime, ...overrides }) };
}

async function establishPlayingRoom(
  client: RelayClient,
  transportId: string,
  currentTime: number,
  commandPrefix: string,
) {
  await playRoomSong(client, { positionSeconds: currentTime, prefix: commandPrefix });

  client.send({ type: 'youtube-timeline-request' });
  const leader = await client.waitFor((message) => (
    message.type === 'youtube-timeline-status'
    && message.playbackLeaderParticipantId === A_ID
    && message.state === 1
  ));
  assert.equal(leader.playbackTransportId, transportId);
}

test('mic takeover prepares the room song before switching playback leader', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'A', 'playback-tab-a');
    const aPublisher = await micPublisher(server, 'A');

    await establishPlayingRoom(aPlayback, 'playback-tab-a', 10, 'handoff-one');

    const bPlayback = await playback(server, 'B', 'playback-tab-b');
    await sleep(120);
    assert.equal(
      bPlayback.messages.some((message) => message.type === 'song-handoff-prepare'),
      false,
      'joining the room must not prepare or autoplay the current song',
    );

    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await micPublisher(server, 'B', A_ID);

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
    assert.equal(bPlayback.latest('youtube-timeline-status')?.playbackLeaderParticipantId, A_ID);

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
      && message.playbackLeaderParticipantId === B_ID
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
    const aPlayback = await playback(server, 'A', 'playback-tab-a');
    const aPublisher = await micPublisher(server, 'A');
    await establishPlayingRoom(aPlayback, 'playback-tab-a', 20, 'handoff-two');

    const bOtherTab = await playback(server, 'B', 'playback-tab-b-other');
    const bMicTab = await playback(server, 'B', 'playback-tab-b-mic');

    bMicTab.send({ type: 'playback-mic-intent' });
    await bMicTab.waitForType('playback-mic-intent-registered');
    const bPublisher = await micPublisher(server, 'B', A_ID);

    const prepare = await bMicTab.waitForType('song-handoff-prepare');
    assert.equal(prepare.videoId, VIDEO);
    await sleep(120);
    assert.equal(
      bOtherTab.messages.some((message) => message.type === 'song-handoff-prepare'),
      false,
      'another live tab from the same person must not receive the handoff',
    );

    // This is intentionally a 0C/SongSession assertion. The packet is not a
    // semantic room-song command mutation, so 1A may pass it through; the exact
    // handoff target lock is what must prevent the sibling tab from taking over.
    bOtherTab.send(telemetry(Number(prepare.serverTime) + 0.05));
    await sleep(80);
    bOtherTab.send({ type: 'youtube-timeline-request' });
    await sleep(40);
    assert.equal(
      bOtherTab.latest('youtube-timeline-status')?.playbackLeaderParticipantId,
      A_ID,
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

test('closing the tab a handoff is waiting for gives the room song back', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'A', 'playback-tab-a');
    const aPublisher = await micPublisher(server, 'A');

    await establishPlayingRoom(aPlayback, 'playback-tab-a', 10, 'handoff-frozen');

    const bPlayback = await playback(server, 'B', 'playback-tab-b');
    const bPublisher = await micPublisher(server, 'B', A_ID);
    await bPlayback.waitForType('song-handoff-prepare');

    // B's YouTube tab goes away before it ever takes over. B still holds the
    // microphone and is still in the room, so nothing else releases the
    // handoff; while it stands, every transport except that dead tab and the
    // old leader is refused as `handoff-not-target`.
    bPlayback.close();

    // A reopened tab for the Mic owner can drive the room again. Under the
    // stuck handoff this transport was refused for ever as `handoff-not-target`.
    // A real page sends continuously, so this does too rather than depending on
    // one packet landing after the sweep.
    // It reports the room's own position rather than a jump, because moving the
    // song is the room command path's job; what is under test here is only
    // whether this transport is allowed to drive the clock at all.
    const bReopened = await playback(server, 'B', 'playback-tab-b-reopened');
    const deadline = Date.now() + 5_000;
    let moved: Record<string, any> | undefined;
    while (Date.now() < deadline && !moved) {
      const roomTime = Number(
        bReopened.latest('youtube-timeline-status')?.serverTime
        ?? aPlayback.latest('youtube-timeline-status')?.serverTime
        ?? 10,
      );
      bReopened.send(telemetry(roomTime));
      await sleep(100);
      moved = bReopened.messages.find((message) => (
        message.type === 'youtube-timeline-status'
        && message.playbackTransportId === 'playback-tab-b-reopened'
      ));
    }

    assert.ok(moved, 'the room song stayed frozen behind a handoff whose target had gone');
    assert.equal(aPlayback.latest('room-song-status')?.handoffState, 'idle');

    aPlayback.close();
    aPublisher.close();
    bPublisher.close();
    bReopened.close();
  } finally {
    await server.stop();
  }
});

test('client-reported commit failure returns the handoff to preparation without replacing the old leader', async () => {
  const server = await startRelay(FAST);
  try {
    const aPlayback = await playback(server, 'A', 'playback-tab-a');
    const aPublisher = await micPublisher(server, 'A');
    await establishPlayingRoom(aPlayback, 'playback-tab-a', 30, 'handoff-failure');

    const bPlayback = await playback(server, 'B', 'playback-tab-b');
    bPlayback.send({ type: 'playback-mic-intent' });
    await bPlayback.waitForType('playback-mic-intent-registered');
    const bPublisher = await micPublisher(server, 'B', A_ID);

    const prepare = await bPlayback.waitForType('song-handoff-prepare');
    bPlayback.send({ type: 'song-handoff-ready', handoffId: prepare.handoffId });
    const commit = await bPlayback.waitForType('song-handoff-commit');
    assert.equal(commit.handoffId, prepare.handoffId);

    const failureStart = bPlayback.messages.length;
    bPlayback.send({ type: 'song-handoff-failed', handoffId: prepare.handoffId });
    const deferred = await bPlayback.waitFor((message) => (
      bPlayback.messages.indexOf(message) >= failureStart
      && message.type === 'youtube-timeline-status'
      && message.handoffState === 'preparing'
    ));
    assert.equal(deferred.playbackLeaderParticipantId, A_ID);
    assert.equal(deferred.playbackTransportId, 'playback-tab-a');

    const room = await bPlayback.waitFor((message) => (
      bPlayback.messages.indexOf(message) >= failureStart
      && message.type === 'room-song-status'
      && message.handoffState === 'preparing'
    ));
    assert.equal(room.handoffTargetParticipantId, B_ID);

    const continuationStart = aPlayback.messages.length;
    aPlayback.send(telemetry(Number(deferred.serverTime) + 0.05));
    const continued = await aPlayback.waitFor((message) => (
      aPlayback.messages.indexOf(message) >= continuationStart
      && message.type === 'youtube-timeline-status'
      && message.playbackLeaderParticipantId === A_ID
      && message.handoffState === 'preparing'
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

