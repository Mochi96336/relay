import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { describe } from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';
import { isNewPlayIntent, settledPlaybackState } from '../public/song-playback-intent.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';
const ENDED = 0;
const PLAYING = 1;
const PAUSED = 2;
const BUFFERING = 3;

function command(commandId: string, expectedRevision: number, action: string, extra: Record<string, unknown> = {}) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision, action, ...extra });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid room song command fixture');
  return parsed.request;
}

/** A room whose song ran to the end: YouTube reports ENDED at the last second. */
function endedRoom(overrides: Record<string, unknown> = {}) {
  return {
    type: 'youtube-timeline-status',
    videoId: VIDEO,
    state: ENDED,
    serverTime: 206.6,
    youtubeTime: 206.6,
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

function begin(session: RoomSongCommandSession, request: ReturnType<typeof command>, room: Record<string, unknown>, revision: number) {
  return session.begin(request, A.participantId, A, A.participantId, room as never, revision, revision + 1, 0);
}

describe('restarting a song that reached its end', () => {
  test('Play against a finished song replays from the start instead of resuming at the ending', () => {
    const session = new RoomSongCommandSession();
    const decision = begin(session, command('command-replay-1', 0, 'play'), endedRoom(), 0);

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    const desired = decision.command.body.desired;
    assert.equal(desired.state, PLAYING);
    // The whole failure was here: folding Play onto a finished room kept the
    // ending as the authoritative position, so the command played the last
    // fraction of a second and ended again.
    assert.equal(desired.positionSeconds, 0);
    assert.equal(desired.ended, false);
  });

  test('a finished room is desired as paused but is not confused with a chosen pause', () => {
    const session = new RoomSongCommandSession();
    const decision = begin(session, command('command-rate-1', 0, 'rate', { playbackRate: 1.25 }), endedRoom(), 0);

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    const desired = decision.command.body.desired;
    // A player can be put into 2, never into "finished" - but the room has to
    // keep knowing which one it is, because that decides what Play means next.
    assert.equal(desired.state, PAUSED);
    assert.equal(desired.ended, true);
    assert.equal(desired.positionSeconds, 206.6);
  });

  test('Play against a genuinely paused song still resumes where it was', () => {
    const session = new RoomSongCommandSession();
    const paused = endedRoom({ state: PAUSED, serverTime: 42, youtubeTime: 42 });
    const decision = begin(session, command('command-resume-1', 0, 'play'), paused, 0);

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.command.body.desired.state, PLAYING);
    assert.equal(decision.command.body.desired.positionSeconds, 42);
    assert.equal(decision.command.body.desired.ended, false);
  });

  test('seeking away from the ending leaves the room no longer finished', () => {
    const session = new RoomSongCommandSession();
    const decision = begin(session, command('command-seek-1', 0, 'seek', { positionSeconds: 30 }), endedRoom(), 0);

    assert.equal(decision.ok, true);
    if (!decision.ok) return;
    assert.equal(decision.command.body.desired.positionSeconds, 30);
    assert.equal(decision.command.body.desired.ended, false);
  });
});

describe('classifying a replay the player reports through BUFFERING', () => {
  test('restarting a finished song is a new play', () => {
    assert.equal(
      isNewPlayIntent({ state: PLAYING, previousState: BUFFERING, previousSettledState: ENDED }),
      true,
    );
  });

  test('rebuffering mid-song is not', () => {
    assert.equal(
      isNewPlayIntent({ state: PLAYING, previousState: BUFFERING, previousSettledState: PLAYING }),
      false,
    );
  });

  test('resuming from pause is a new play, with or without buffering in between', () => {
    assert.equal(isNewPlayIntent({ state: PLAYING, previousState: PAUSED, previousSettledState: PAUSED }), true);
    assert.equal(isNewPlayIntent({ state: PLAYING, previousState: BUFFERING, previousSettledState: PAUSED }), true);
  });

  test('a sample that is already playing is not a new play', () => {
    assert.equal(isNewPlayIntent({ state: PLAYING, previousState: PLAYING, previousSettledState: PLAYING }), false);
  });

  test('the settled state survives consecutive buffering samples', () => {
    let previous: { state: number; previousSettledState: number | null } | null = null;
    const sample = (state: number) => {
      const previousSettledState = settledPlaybackState(previous);
      previous = { state, previousSettledState };
      return previous;
    };

    sample(PLAYING);
    sample(ENDED);
    sample(BUFFERING);
    sample(BUFFERING);
    const playing = sample(PLAYING);

    assert.equal(playing.previousSettledState, ENDED);
    assert.equal(
      isNewPlayIntent({ state: PLAYING, previousState: BUFFERING, previousSettledState: playing.previousSettledState }),
      true,
    );
  });
});

test('the player sampler and classifier use the shared intent module', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  assert.match(source, /import \{ isNewPlayIntent, settledPlaybackState \} from '\.\/song-playback-intent\.js'/);
  assert.match(source, /previousSettledState: settledPlaybackState\(previous\)/);
  assert.match(source, /if \(isNewPlayIntent\(snapshot\)\) \{/);
});
