import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';

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
    state: 2,
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

function beginPlay(session: RoomSongCommandSession) {
  const begun = session.begin(
    command('command-play-life', 0, 'play'),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);
}

test('low-rate telemetry can still prove state-only completion without a time grace', () => {
  const session = new RoomSongCommandSession();
  beginPlay(session);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 11 }),
      A,
      room({ state: 2, serverTime: 11, youtubeTime: 10, ageMs: 1_000 }),
      1_000,
    ),
    { ok: true },
  );

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 13 }),
      A,
      room({ state: 1, serverTime: 13, youtubeTime: 11, ageMs: 2_000 }),
      3_000,
    ),
    { ok: true, completesCommandId: 'command-play-life' },
  );
});

test('one lost telemetry packet does not erase a stable completion candidate', () => {
  const session = new RoomSongCommandSession();
  beginPlay(session);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 10.5 }),
      A,
      room({ state: 2, serverTime: 10.5, youtubeTime: 10, ageMs: 500 }),
      500,
    ),
    { ok: true },
  );

  // The nominal middle sample is absent. Evidence is observation-counted, not
  // wall-clock-grace based, so the next stable report can still confirm it.
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 12.5 }),
      A,
      room({ state: 1, serverTime: 12.5, youtubeTime: 10.5, ageMs: 2_000 }),
      2_500,
    ),
    { ok: true, completesCommandId: 'command-play-life' },
  );
});

test('stable proof can finish just before timeout and cannot resurrect after timeout', () => {
  const completes = new RoomSongCommandSession();
  beginPlay(completes);

  assert.deepEqual(
    completes.gateTelemetry(
      telemetry({ currentTime: 13.9 }),
      A,
      room({ state: 2, serverTime: 13.9, youtubeTime: 10, ageMs: 3_900 }),
      3_900,
    ),
    { ok: true },
  );
  assert.deepEqual(
    completes.gateTelemetry(
      telemetry({ currentTime: 13.999 }),
      A,
      room({ state: 1, serverTime: 13.999, youtubeTime: 13.9, ageMs: 99 }),
      3_999,
    ),
    { ok: true, completesCommandId: 'command-play-life' },
  );

  const expires = new RoomSongCommandSession();
  beginPlay(expires);
  assert.deepEqual(
    expires.gateTelemetry(
      telemetry({ currentTime: 13.999 }),
      A,
      room({ state: 2, serverTime: 13.999, youtubeTime: 10, ageMs: 3_999 }),
      3_999,
    ),
    { ok: true },
  );

  const terminal = expires.sweep(4_001);
  assert.equal(terminal?.commandId, 'command-play-life');
  assert.equal(expires.statusPayload(1, 4_001).pendingCommandId, null);
});

test('superseding intent resets the predecessor stable-proof candidate', () => {
  const session = new RoomSongCommandSession();
  beginPlay(session);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 10.2 }),
      A,
      room({ state: 2, serverTime: 10.2, youtubeTime: 10, ageMs: 200 }),
      200,
    ),
    { ok: true },
  );

  const pause = session.begin(
    command('command-pause-life', 0, 'pause', { supersedesCommandId: 'command-play-life' }),
    A.participantId,
    A,
    null,
    room({ state: 1, serverTime: 10.3, youtubeTime: 10.2, ageMs: 100 }),
    1,
    2,
    300,
  );
  assert.equal(pause.ok, true);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 2, currentTime: 10.3 }),
      A,
      room({ state: 1, serverTime: 10.3, youtubeTime: 10.2, ageMs: 100 }),
      400,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 2, currentTime: 10.3 }),
      A,
      room({ state: 2, serverTime: 10.3, youtubeTime: 10.3, ageMs: 100 }),
      500,
    ),
    { ok: true, completesCommandId: 'command-pause-life' },
  );
});

test('PLAYING to BUFFERING to PLAYING requires a fresh stable pair', () => {
  const session = new RoomSongCommandSession();
  beginPlay(session);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 10.2 }),
      A,
      room({ state: 2, serverTime: 10.2, youtubeTime: 10, ageMs: 200 }),
      200,
    ),
    { ok: true },
  );

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 3, currentTime: 10.2 }),
      A,
      room({ state: 1, serverTime: 10.2, youtubeTime: 10.2, ageMs: 100 }),
      300,
    ),
    { ok: true },
  );

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 10.4 }),
      A,
      room({ state: 3, serverTime: 10.4, youtubeTime: 10.2, ageMs: 200 }),
      500,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ currentTime: 10.6 }),
      A,
      room({ state: 1, serverTime: 10.6, youtubeTime: 10.4, ageMs: 200 }),
      700,
    ),
    { ok: true, completesCommandId: 'command-play-life' },
  );
});
