import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';
import { roomSongCommandConvergence } from '../public/room-song-command-convergence.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';
const OTHER_VIDEO = '9bZkp7q19f0';

function command(commandId: string, expectedRevision: number, action: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision, action, ...extra });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid room song command fixture');
  return parsed.request;
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    type: 'youtube-timeline-status',
    videoId: VIDEO,
    state: 1,
    serverTime: 10,
    youtubeTime: 10,
    ageMs: 0,
    playbackRate: 1,
    playbackLeaderParticipantId: A.participantId,
    playbackTransportId: A.transportId,
    playbackGeneration: A.generation,
    connected: true,
    leaderConnected: true,
    leaderFresh: true,
    handoffState: 'idle',
    ...overrides,
  };
}

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    timelineDeltaSeconds: 0,
    ...overrides,
  };
}

test('explicit Seek target is apply-time 80 even when proof arrives two seconds later', () => {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    command('command-seek-delay', 0, 'seek', { positionSeconds: 80 }),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 80.2 }),
      A,
      room({ serverTime: 12, youtubeTime: 10, ageMs: 2_000 }),
      2_000,
    ),
    { ok: true, completesCommandId: 'command-seek-delay' },
  );
});

test('command age cannot turn Seek(80) into positional proof for 82', () => {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    command('command-seek-no-age', 0, 'seek', { positionSeconds: 80 }),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 82 }),
      A,
      room({ serverTime: 12, youtubeTime: 10, ageMs: 2_000 }),
      2_000,
    ),
    { ok: false, reason: 'command-mismatch' },
  );
});

test('shared convergence ignores a projected pre-apply age for position proof', () => {
  const desired = {
    videoId: VIDEO,
    positionSeconds: 80,
    state: 1,
    playbackRate: 1,
    mustApplyPosition: true,
  };

  assert.equal(
    roomSongCommandConvergence({
      desired,
      projectedPositionSeconds: 82,
      observed: { videoId: VIDEO, currentTime: 80.1, state: 1, playbackRate: 1 },
    }),
    'complete',
  );
  assert.equal(
    roomSongCommandConvergence({
      desired,
      projectedPositionSeconds: 82,
      observed: { videoId: VIDEO, currentTime: 82, state: 1, playbackRate: 1 },
    }),
    'none',
  );
});

test('Load keeps its requested position exact across delivery delay', () => {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    command('command-load-delay', 0, 'load', { videoId: OTHER_VIDEO, positionSeconds: 30 }),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ videoId: OTHER_VIDEO, state: 5, currentTime: 30.1 }),
      A,
      room({ serverTime: 12, youtubeTime: 10, ageMs: 2_000 }),
      2_000,
    ),
    { ok: true, completesCommandId: 'command-load-delay' },
  );
});

test('Replay keeps zero as its apply-time position across delivery delay', () => {
  const session = new RoomSongCommandSession();
  const endedRoom = room({ state: 0, serverTime: 206.6, youtubeTime: 206.6 });
  const begun = session.begin(
    command('command-replay-delay', 0, 'play'),
    A.participantId,
    A,
    null,
    endedRoom,
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);
  if (!begun.ok) return;
  assert.equal(begun.command.body.desired.positionSeconds, 0);
  assert.equal(begun.command.body.desired.mustApplyPosition, true);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 0.2 }),
      A,
      endedRoom,
      2_000,
    ),
    { ok: true, completesCommandId: 'command-replay-delay' },
  );
});

test('a delayed Seek superseded by Play preserves the unapplied 80 target exactly', () => {
  const session = new RoomSongCommandSession();
  const seek = session.begin(
    command('command-seek-inherit', 0, 'seek', { positionSeconds: 80 }),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(seek.ok, true);

  const play = session.begin(
    command('command-play-inherit', 0, 'play', { supersedesCommandId: 'command-seek-inherit' }),
    A.participantId,
    A,
    null,
    room({ serverTime: 12 }),
    1,
    2,
    2_000,
  );
  assert.equal(play.ok, true);
  if (!play.ok) return;
  assert.equal(play.command.body.desired.positionSeconds, 80);
  assert.equal(play.command.body.desired.mustApplyPosition, true);
  assert.equal(play.command.body.desired.state, 1);
});
