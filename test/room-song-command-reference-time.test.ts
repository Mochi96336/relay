import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';

function command(commandId: string, action: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision: 0, action, ...extra });
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

function pendingSeek(positionSeconds = 80) {
  const session = new RoomSongCommandSession();
  const accepted = session.begin(
    command('command-seek-1', 'seek', { positionSeconds }),
    A.participantId,
    A,
    A.participantId,
    room(),
    0,
    1,
    0,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) throw new Error('seek fixture was rejected');
  return { session, accepted };
}

test('a delayed playing Seek can prove at the apply-time target', () => {
  const { session, accepted } = pendingSeek();
  assert.equal(accepted.command.body.desired.mustApplyPosition, true);
  assert.equal(accepted.command.body.desired.positionSeconds, 80);

  // The command may spend two seconds in transport/player startup before the
  // browser calls seekTo(80). Server issue time must not turn that target into 82.
  assert.deepEqual(
    session.gateTelemetry(telemetry({ currentTime: 80.1 }), A, room(), 2_000),
    { ok: true, completesCommandId: 'command-seek-1' },
  );
});

test('a playing Seek can also prove after media advanced since an early apply', () => {
  const { session } = pendingSeek();

  // The server does not know whether apply happened at t=0 or t=2s. At t=2s,
  // both 80 (late apply) and 82 (early apply + playback) are causally possible.
  assert.deepEqual(
    session.gateTelemetry(telemetry({ currentTime: 82 }), A, room(), 2_000),
    { ok: true, completesCommandId: 'command-seek-1' },
  );
});

test('a playing Seek proof cannot escape its causal apply-time window', () => {
  const { session } = pendingSeek();

  // At t=2s the causal window is 80..82, plus the ordinary positional proof
  // tolerance. 84 is outside it and cannot be explained by this command.
  assert.deepEqual(
    session.gateTelemetry(telemetry({ currentTime: 84 }), A, room(), 2_000),
    { ok: false, reason: 'command-mismatch' },
  );
});

test('a delayed replay uses the same apply-time action window', () => {
  const session = new RoomSongCommandSession();
  const endedRoom = room({ state: 0, serverTime: 200, youtubeTime: 200 });
  const accepted = session.begin(
    command('command-replay-1', 'play'),
    A.participantId,
    A,
    A.participantId,
    endedRoom,
    0,
    1,
    0,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.command.body.desired.mustApplyPosition, true);
  assert.equal(accepted.command.body.desired.positionSeconds, 0);

  assert.deepEqual(
    session.gateTelemetry(telemetry({ currentTime: 2 }), A, endedRoom, 2_000),
    { ok: true, completesCommandId: 'command-replay-1' },
  );
});

test('state-only playing intent still projects descriptive room position while pending', () => {
  const session = new RoomSongCommandSession();
  const pausedRoom = room({ state: 2 });
  const accepted = session.begin(
    command('command-play-1', 'play'),
    A.participantId,
    A,
    A.participantId,
    pausedRoom,
    0,
    1,
    0,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.command.body.desired.mustApplyPosition, false);

  // Position is descriptive only here. A normal Play is allowed to advance its
  // causal clock without gaining authority to seek the player to that number.
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 12, timelineDeltaSeconds: 0 }),
      A,
      pausedRoom,
      2_000,
    ),
    { ok: true },
  );
});
