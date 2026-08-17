import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';

function command(
  commandId: string,
  expectedRevision: number,
  action: string,
  extra: Record<string, unknown> = {},
) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision, action, ...extra });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid room song command fixture');
  return parsed.request;
}

function room(overrides: Record<string, unknown> = {}) {
  return {
    type: 'youtube-timeline-status',
    videoId: VIDEO,
    state: 2,
    serverTime: 10,
    // What the player itself last reported, projected to now, and how long ago
    // that was. The real status payload always carries both; a seek is judged
    // against them rather than against the room's prediction.
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
    state: 2,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...overrides,
  };
}

describe('room song latest-intent convergence', () => {
  test('accepts an explicit causal predecessor in the public envelope', () => {
    const parsed = command('command-seek-2', 0, 'seek', {
      supersedesCommandId: 'command-seek-1',
      positionSeconds: 40,
    });
    assert.equal(parsed.supersedesCommandId, 'command-seek-1');
  });

  test('a rapid successor can advance from the predecessor observed revision', () => {
    const session = new RoomSongCommandSession();
    const first = session.begin(
      command('command-seek-1', 0, 'seek', { positionSeconds: 40 }),
      A.participantId,
      A,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.equal(first.ok, true);

    const second = session.begin(
      command('command-play-2', 0, 'play', { supersedesCommandId: 'command-seek-1' }),
      A.participantId,
      A,
      A.participantId,
      room(),
      1,
      2,
      100,
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.command.revision, 2);
    assert.equal(second.command.supersedesCommandId, 'command-seek-1');
    assert.deepEqual(second.command.body.desired, {
      videoId: VIDEO,
      positionSeconds: 40,
      state: 1,
      playbackRate: 1,
    });
  });

  test('folds seek, pause and rate into one self-contained latest desired state', () => {
    const session = new RoomSongCommandSession();
    const playingRoom = room({ state: 1 });

    const seek = session.begin(
      command('command-seek-1', 0, 'seek', { positionSeconds: 40 }),
      A.participantId,
      A,
      A.participantId,
      playingRoom,
      0,
      1,
      0,
    );
    assert.equal(seek.ok, true);

    const pause = session.begin(
      command('command-pause-2', 0, 'pause', { supersedesCommandId: 'command-seek-1' }),
      A.participantId,
      A,
      A.participantId,
      playingRoom,
      1,
      2,
      100,
    );
    assert.equal(pause.ok, true);

    const rate = session.begin(
      command('command-rate-3', 0, 'rate', {
        supersedesCommandId: 'command-pause-2',
        playbackRate: 1.25,
      }),
      A.participantId,
      A,
      A.participantId,
      playingRoom,
      2,
      3,
      200,
    );
    assert.equal(rate.ok, true);
    if (!rate.ok) return;
    assert.deepEqual(rate.command.body.desired, {
      videoId: VIDEO,
      positionSeconds: 40.1,
      state: 2,
      playbackRate: 1.25,
    });
  });

  test('survives the race where the predecessor completes before its successor arrives', () => {
    const session = new RoomSongCommandSession();
    const first = session.begin(
      command('command-play-1', 0, 'play'),
      A.participantId,
      A,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.equal(first.ok, true);
    assert.equal(session.complete('command-play-1'), true);

    const second = session.begin(
      command('command-pause-2', 0, 'pause', { supersedesCommandId: 'command-play-1' }),
      A.participantId,
      A,
      A.participantId,
      room({ state: 1, serverTime: 10.1 }),
      1,
      2,
      100,
    );
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.command.revision, 2);
    assert.equal(second.command.body.desired.state, 2);
  });

  test('does not accept a predecessor that is not the current causal tip', () => {
    const session = new RoomSongCommandSession();
    session.begin(
      command('command-seek-1', 0, 'seek', { positionSeconds: 40 }),
      A.participantId,
      A,
      A.participantId,
      room(),
      0,
      1,
      0,
    );

    const invalid = session.begin(
      command('command-seek-2', 0, 'seek', {
        supersedesCommandId: 'command-other-9',
        positionSeconds: 80,
      }),
      A.participantId,
      A,
      A.participantId,
      room(),
      1,
      2,
      100,
    );
    assert.deepEqual(invalid, { ok: false, reason: 'supersession-mismatch' });
  });

  test('late telemetry from a superseded apply cannot complete the latest command', () => {
    const session = new RoomSongCommandSession();
    session.begin(
      command('command-seek-1', 0, 'seek', { positionSeconds: 40 }),
      A.participantId,
      A,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    session.begin(
      command('command-seek-2', 0, 'seek', {
        supersedesCommandId: 'command-seek-1',
        positionSeconds: 80,
      }),
      A.participantId,
      A,
      A.participantId,
      room(),
      1,
      2,
      100,
    );

    assert.deepEqual(session.gateTelemetry(telemetry({ currentTime: 40 }), A, room(), 150), {
      ok: false,
      reason: 'command-mismatch',
    });
    assert.deepEqual(session.gateTelemetry(telemetry({ currentTime: 80 }), A, room(), 150), {
      ok: true,
      completesCommandId: 'command-seek-2',
    });
  });

  test('proof must match the full desired state, not only the last mutation kind', () => {
    const session = new RoomSongCommandSession();
    session.begin(
      command('command-seek-1', 0, 'seek', { positionSeconds: 40 }),
      A.participantId,
      A,
      A.participantId,
      room({ state: 1 }),
      0,
      1,
      0,
    );
    session.begin(
      command('command-pause-2', 0, 'pause', { supersedesCommandId: 'command-seek-1' }),
      A.participantId,
      A,
      A.participantId,
      room({ state: 1 }),
      1,
      2,
      100,
    );

    assert.deepEqual(session.gateTelemetry(telemetry({ state: 2, currentTime: 10 }), A, room({ state: 1 }), 150), {
      ok: false,
      reason: 'command-mismatch',
    });
    assert.deepEqual(session.gateTelemetry(telemetry({ state: 2, currentTime: 40.1 }), A, room({ state: 1 }), 150), {
      ok: true,
      completesCommandId: 'command-pause-2',
    });
  });
});
