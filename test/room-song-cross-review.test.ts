import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

// Final cross-review boundary: browser provenance is advisory; server proof is authoritative.
import {
  ROOM_SONG_RATE_TOLERANCE,
  roomSongCommandConvergence,
} from '../public/room-song-command-convergence.js';
import { shouldSetPlaybackRate } from '../public/room-song-seek-policy.js';
import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';

function command(commandId: string, action: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision: 0, action, ...extra });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid command fixture');
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

function pendingPlay(commandId: string) {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    command(commandId, 'play'),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);
  return session;
}

test('server rejects a stable pending Play scrub when no correction debt exists', () => {
  for (const delta of [1, -1]) {
    const session = pendingPlay('command-play-scrub-' + (delta > 0 ? 'fwd' : 'back'));
    assert.deepEqual(
      session.gateTelemetry(
        telemetry({ currentTime: 10.2, timelineDeltaSeconds: 0 }),
        A,
        room({ state: 2, serverTime: 10.2, youtubeTime: 10, ageMs: 200 }),
        200,
      ),
      { ok: true },
    );

    assert.deepEqual(
      session.gateTelemetry(
        telemetry({
          currentTime: delta > 0 ? 11.4 : 9.4,
          timelineDeltaSeconds: delta,
        }),
        A,
        room({ state: 1, serverTime: 10.4, youtubeTime: 10.2, ageMs: 200 }),
        400,
      ),
      { ok: false, reason: 'command-mismatch' },
    );
  }
});

test('server lets the first Play BUFFERING edge create bounded correction debt', () => {
  const session = pendingPlay('command-play-buffer-debt');
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 3, currentTime: 10.8, timelineDeltaSeconds: 0.8 }),
      A,
      room({ state: 2, serverTime: 10, youtubeTime: 10, ageMs: 300 }),
      300,
    ),
    { ok: true },
  );

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 10.1, timelineDeltaSeconds: -1 }),
      A,
      room({ state: 3, serverTime: 10.8, youtubeTime: 10.8, ageMs: 300 }),
      600,
    ),
    { ok: true },
  );
});

test('browser treats command-authorized BUFFERING as a one-shot Play transition', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const start = source.indexOf('function roomSongCommandTransitionsObserved');
  assert.ok(start >= 0);
  const section = source.slice(start, start + 1_300);
  assert.match(section, /observedCommandTransitions/);
  assert.match(section, /Number\(snapshot\.state\) === 3/);
  assert.match(section, /previousSettledState/);
  assert.match(source, /mutation\.observedCommandTransitions\.add/);
});

test('rate actuation and convergence share one equality tolerance', () => {
  assert.equal(ROOM_SONG_RATE_TOLERANCE, 0.0001);
  assert.equal(shouldSetPlaybackRate({ currentRate: 1, desiredRate: 1.0005 }), true);
  assert.equal(
    roomSongCommandConvergence({
      desired: {
        videoId: VIDEO,
        positionSeconds: 10,
        state: 1,
        playbackRate: 1.0005,
        mustApplyPosition: false,
      },
      observed: { videoId: VIDEO, currentTime: 10, state: 1, playbackRate: 1 },
    }),
    'none',
  );
  assert.equal(
    shouldSetPlaybackRate({
      currentRate: 1,
      desiredRate: 1 + ROOM_SONG_RATE_TOLERANCE / 2,
    }),
    false,
  );
});


function pendingPlayThenRate(prefix: string) {
  const session = new RoomSongCommandSession();
  const play = session.begin(
    command(`${prefix}-play`, 'play'),
    A.participantId,
    A,
    null,
    room(),
    0,
    1,
    0,
  );
  assert.equal(play.ok, true);
  if (!play.ok) throw new Error('play fixture was rejected');

  const rate = session.begin(
    command(`${prefix}-rate`, 'rate', {
      playbackRate: 1.25,
      supersedesCommandId: play.command.commandId,
    }),
    A.participantId,
    A,
    null,
    room(),
    1,
    2,
    100,
  );
  assert.equal(rate.ok, true);
  if (!rate.ok) throw new Error('rate fixture was rejected');
  assert.deepEqual(rate.command.body.ownedMutations, ['play', 'rate']);
  return { session, commandId: rate.command.commandId };
}

test('folded Play -> Rate accepts rate-first partial progress before PLAYING', () => {
  const { session, commandId } = pendingPlayThenRate('fold-rate-first');
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 2, playbackRate: 1.25, currentTime: 10.1, timelineDeltaSeconds: 0 }),
      A,
      room({ state: 2, playbackRate: 1, serverTime: 10.1, youtubeTime: 10, ageMs: 100 }),
      200,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, playbackRate: 1.25, currentTime: 10.2, timelineDeltaSeconds: 0.1 }),
      A,
      room({ state: 2, playbackRate: 1.25, serverTime: 10.2, youtubeTime: 10.1, ageMs: 100 }),
      300,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, playbackRate: 1.25, currentTime: 10.3, timelineDeltaSeconds: 0.1 }),
      A,
      room({ state: 1, playbackRate: 1.25, serverTime: 10.3, youtubeTime: 10.2, ageMs: 100 }),
      400,
    ),
    { ok: true, completesCommandId: commandId },
  );
});

test('folded Play -> Rate accepts PLAYING-first partial progress before rate', () => {
  const { session, commandId } = pendingPlayThenRate('fold-play-first');
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, playbackRate: 1, currentTime: 10.1, timelineDeltaSeconds: 0.1 }),
      A,
      room({ state: 2, playbackRate: 1, serverTime: 10.1, youtubeTime: 10, ageMs: 100 }),
      200,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, playbackRate: 1.25, currentTime: 10.2, timelineDeltaSeconds: 0.1 }),
      A,
      room({ state: 1, playbackRate: 1, serverTime: 10.2, youtubeTime: 10.1, ageMs: 100 }),
      300,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, playbackRate: 1.25, currentTime: 10.3, timelineDeltaSeconds: 0.1 }),
      A,
      room({ state: 1, playbackRate: 1.25, serverTime: 10.3, youtubeTime: 10.2, ageMs: 100 }),
      400,
    ),
    { ok: true, completesCommandId: commandId },
  );
});

test('folded authority never absorbs an unrelated Seek', () => {
  const { session } = pendingPlayThenRate('fold-unowned-seek');
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 2, playbackRate: 1.25, currentTime: 12, timelineDeltaSeconds: 2 }),
      A,
      room({ state: 2, playbackRate: 1, serverTime: 10.1, youtubeTime: 10, ageMs: 100 }),
      200,
    ),
    { ok: false, reason: 'command-mismatch' },
  );
});

test('browser carries folded mutation authority and predecessor provenance', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(source, /ownedMutations/);
  assert.match(source, /observedCommandTransitions/);
  assert.match(source, /supersedesCommandId === serverMutation\.commandId/);
  assert.match(source, /roomCommandOwnsLocalAction/);
  assert.match(server, /supersedesCommandId: command\.supersedesCommandId/);
});
