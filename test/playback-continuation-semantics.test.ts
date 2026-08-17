import assert from 'node:assert/strict';
import test from 'node:test';

import {
  playbackContinuationDecision,
  reloadDesiredFromRoom,
} from '../public/playback-continuation.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';
import { SongSession } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const OTHER_VIDEO = 'M7lc1UVf-VE';
const A = {
  participantId: 'participant-a',
  transportId: 'playback-tab-a',
  generation: 10,
};
const A_RELOAD = { ...A, generation: 11 };

function telemetry(state: number, currentTime = 199, overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state,
    currentTime,
    duration: 199,
    playbackRate: 1,
    bufferedFraction: 1,
    timelineDeltaSeconds: 0,
    ...overrides,
  };
}

function endedRoom(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 0,
    serverTime: 199,
    youtubeTime: 199,
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

test('reload desired state maps terminal YouTube state to paused at the same position', () => {
  assert.deepEqual(reloadDesiredFromRoom({
    videoId: VIDEO,
    state: 0,
    serverTime: 199,
    playbackRate: 1,
  }), {
    videoId: VIDEO,
    state: 2,
    positionSeconds: 199,
    playbackRate: 1,
  });

  assert.equal(reloadDesiredFromRoom({ videoId: 'not-a-video' }), null);
});

test('reload continuation key changes when authoritative room revision changes', () => {
  const base = {
    role: 'holder',
    timeline: {
      playbackTransportId: A.transportId,
      playbackGeneration: A.generation,
    },
    transportId: A.transportId,
    playbackGeneration: A_RELOAD.generation,
  };

  const first = playbackContinuationDecision({
    ...base,
    room: { revision: 7, videoId: VIDEO, state: 1, playbackRate: 1 },
  });
  const same = playbackContinuationDecision({
    ...base,
    room: { revision: 7, videoId: VIDEO, state: 1, playbackRate: 1 },
  });
  const changed = playbackContinuationDecision({
    ...base,
    room: { revision: 8, videoId: VIDEO, state: 2, playbackRate: 1 },
  });

  assert.equal(first.phase, 'continuing');
  assert.equal(first.key, same.key);
  assert.notEqual(first.key, changed.key);
  assert.match(changed.key ?? '', /:r8:/);
});

test('terminal reload proof is allowed only for a newer incarnation of the same logical transport', () => {
  const commands = new RoomSongCommandSession();
  const proof = telemetry(2);

  assert.deepEqual(
    commands.gateTelemetry(proof, A_RELOAD, endedRoom(), 100),
    { ok: true },
  );

  assert.deepEqual(
    commands.gateTelemetry(proof, { ...A_RELOAD, transportId: 'playback-tab-other' }, endedRoom(), 100),
    { ok: false, reason: 'command-required' },
  );
  assert.deepEqual(
    commands.gateTelemetry({ ...proof, videoId: OTHER_VIDEO }, A_RELOAD, endedRoom(), 100),
    { ok: false, reason: 'command-required' },
  );
  assert.deepEqual(
    commands.gateTelemetry({ ...proof, playbackRate: 1.25 }, A_RELOAD, endedRoom(), 100),
    { ok: false, reason: 'command-required' },
  );
  assert.deepEqual(
    commands.gateTelemetry({ ...proof, currentTime: 190 }, A_RELOAD, endedRoom(), 100),
    { ok: false, reason: 'command-required' },
  );
  assert.deepEqual(
    commands.gateTelemetry(proof, A_RELOAD, endedRoom({ state: 1 }), 100),
    { ok: false, reason: 'command-required' },
  );
});

test('an ended room can promote the reloaded generation without a synthetic Pause command', () => {
  const songs = new SongSession();
  const commands = new RoomSongCommandSession();

  const initial = songs.update(telemetry(0), A, null, 0);
  assert.equal(initial.accepted, true);

  const roomBeforeReload = songs.statusPayload(100) as Record<string, unknown>;
  assert.equal(roomBeforeReload.state, 0);
  assert.equal(roomBeforeReload.playbackGeneration, A.generation);

  const restoredTelemetry = telemetry(2);
  assert.deepEqual(
    commands.gateTelemetry(restoredTelemetry, A_RELOAD, roomBeforeReload, 100),
    { ok: true },
  );

  const promoted = songs.update(restoredTelemetry, A_RELOAD, null, 100);
  assert.equal(promoted.accepted, true);
  assert.equal(promoted.leaderChanged, true);
  assert.equal(
    (songs.statusPayload(100) as Record<string, unknown>).playbackGeneration,
    A_RELOAD.generation,
  );
});
