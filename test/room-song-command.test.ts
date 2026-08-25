import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const A2 = { participantId: 'participant-a', transportId: 'playback-tab-a2', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };
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
    state: 2,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...overrides,
  };
}

describe('room song command parser', () => {
  test('accepts load, transport and rate commands', () => {
    assert.deepEqual(
      command('command-load-1', 0, 'load', { videoId: VIDEO, positionSeconds: 12 }),
      {
        commandId: 'command-load-1',
        expectedRevision: 0,
        supersedesCommandId: null,
        body: { action: 'load', videoId: VIDEO, positionSeconds: 12 },
      },
    );
    assert.equal(command('command-play-1', 1, 'play').body.action, 'play');
    assert.equal(command('command-pause-1', 2, 'pause').body.action, 'pause');
    assert.deepEqual(command('command-seek-1', 3, 'seek', { positionSeconds: 42 }).body, {
      action: 'seek',
      positionSeconds: 42,
    });
    assert.deepEqual(command('command-rate-1', 4, 'rate', { playbackRate: 1.25 }).body, {
      action: 'rate',
      playbackRate: 1.25,
    });
  });

  test('rejects malformed ids, revisions and media values', () => {
    assert.deepEqual(parseRoomSongCommand({ commandId: 'x', expectedRevision: 0, action: 'play' }), {
      ok: false,
      reason: 'invalid-command-id',
    });
    assert.deepEqual(parseRoomSongCommand({ commandId: 'command-good', expectedRevision: -1, action: 'play' }), {
      ok: false,
      reason: 'invalid-revision',
    });
    assert.deepEqual(parseRoomSongCommand({
      commandId: 'command-good', expectedRevision: 0, action: 'load', videoId: 'bad',
    }), { ok: false, reason: 'invalid-command' });
    assert.deepEqual(parseRoomSongCommand({
      commandId: 'command-good', expectedRevision: 0, action: 'seek', positionSeconds: -1,
    }), { ok: false, reason: 'invalid-command' });
  });
});

describe('room song command authority and serialization', () => {
  test('allows the first explicit load to establish a mic-free room', () => {
    const session = new RoomSongCommandSession();
    const result = session.begin(
      command('command-load-1', 0, 'load', { videoId: VIDEO }),
      A.participantId,
      A,
      null,
      room({
        videoId: undefined,
        state: undefined,
        serverTime: undefined,
        playbackLeaderParticipantId: null,
        playbackTransportId: null,
        playbackGeneration: null,
        leaderConnected: false,
        leaderFresh: false,
      }),
      0,
      1,
      0,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.command.revision, 1);
    assert.equal(result.command.issuedByParticipantId, A.participantId);
    assert.deepEqual(result.command.target, A);
  });

  test('requires the current Mic owner and exact healthy playback leader', () => {
    const session = new RoomSongCommandSession();

    const other = session.begin(
      command('command-play-1', 0, 'play'),
      B.participantId,
      B,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.deepEqual(other, { ok: false, reason: 'mic-owner-required' });

    const otherLoad = session.begin(
      command('command-load-2', 0, 'load', { videoId: OTHER_VIDEO }),
      B.participantId,
      B,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.deepEqual(otherLoad, { ok: false, reason: 'mic-owner-required' });

    const sibling = session.begin(
      command('command-play-2', 0, 'play'),
      A.participantId,
      A2,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.deepEqual(sibling, { ok: false, reason: 'playback-leader-required' });
  });

  test('requires playback handoff when Mic ownership moved ahead of playback', () => {
    const session = new RoomSongCommandSession();
    const result = session.begin(
      command('command-play-1', 0, 'play'),
      B.participantId,
      B,
      B.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.deepEqual(result, { ok: false, reason: 'playback-handoff-required' });
  });

  test('delegates a shared Mic-free load to the healthy playback leader', () => {
    const session = new RoomSongCommandSession();
    const result = session.begin(
      command('command-shared-load-1', 0, 'load', { videoId: OTHER_VIDEO }),
      B.participantId,
      B,
      null,
      room(),
      0,
      1,
      0,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.command.issuedByParticipantId, B.participantId);
    assert.deepEqual(result.command.target, A);
    assert.equal(result.command.body.action, 'load');
    assert.equal(result.command.body.videoId, OTHER_VIDEO);
  });

  test('keeps a briefly stale but product-held leader as the shared load target', () => {
    const heldSession = new RoomSongCommandSession();
    const held = heldSession.begin(
      command('command-held-load-1', 0, 'load', { videoId: OTHER_VIDEO }),
      B.participantId,
      B,
      null,
      room({ leaderFresh: false, connected: false, ageMs: 2_000 }),
      0,
      1,
      2_000,
    );
    assert.equal(held.ok, true);
    if (held.ok) assert.deepEqual(held.command.target, A);

    const expiredSession = new RoomSongCommandSession();
    const expired = expiredSession.begin(
      command('command-expired-load-1', 0, 'load', { videoId: OTHER_VIDEO }),
      B.participantId,
      B,
      null,
      room({ leaderFresh: false, connected: false, ageMs: 6_001 }),
      0,
      1,
      6_001,
    );
    assert.equal(expired.ok, true);
    if (expired.ok) assert.deepEqual(expired.command.target, B);
  });

  test('timeout sweep returns the terminal command exactly once', () => {
    const session = new RoomSongCommandSession();
    const begun = session.begin(
      command('command-timeout-1', 0, 'load', { videoId: OTHER_VIDEO }),
      A.participantId,
      A,
      null,
      room(),
      0,
      1,
      0,
    );
    assert.equal(begun.ok, true);
    assert.equal(session.sweep(4_001)?.commandId, 'command-timeout-1');
    assert.equal(session.sweep(4_002), null);
  });

  test('does not delegate transport controls from a Mic-free observer', () => {
    const session = new RoomSongCommandSession();
    const result = session.begin(
      command('command-shared-play-1', 0, 'play'),
      B.participantId,
      B,
      null,
      room(),
      0,
      1,
      0,
    );
    assert.deepEqual(result, { ok: false, reason: 'playback-leader-required' });
  });

  test('uses expectedRevision as a compare-and-swap boundary', () => {
    const session = new RoomSongCommandSession();
    const result = session.begin(
      command('command-play-1', 4, 'play'),
      A.participantId,
      A,
      A.participantId,
      room(),
      5,
      6,
      0,
    );
    assert.deepEqual(result, { ok: false, reason: 'stale-revision' });
  });

  test('keeps unchained writes serial while causal successors use the 1B path', () => {
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

    const second = session.begin(
      command('command-seek-1', 1, 'seek', { positionSeconds: 30 }),
      A.participantId,
      A,
      A.participantId,
      room(),
      1,
      2,
      100,
    );
    assert.deepEqual(second, { ok: false, reason: 'command-pending' });
  });

  test('deduplicates an accepted command id without allocating another revision', () => {
    const session = new RoomSongCommandSession();
    const request = command('command-play-1', 0, 'play');
    const first = session.begin(request, A.participantId, A, A.participantId, room(), 0, 1, 0);
    assert.equal(first.ok, true);
    const duplicate = session.begin(request, A.participantId, A, A.participantId, room(), 1, 2, 100);
    assert.equal(duplicate.ok, true);
    if (!duplicate.ok) return;
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.command.revision, 1);
  });
});

describe('room song position provenance', () => {
  function desiredOf(session: RoomSongCommandSession, decision: ReturnType<RoomSongCommandSession['begin']>) {
    assert.equal(decision.ok, true);
    if (!decision.ok) throw new Error('command was refused');
    return decision.command.body.desired;
  }

  function begin(
    session: RoomSongCommandSession,
    request: ReturnType<typeof command>,
    roomStatus: ReturnType<typeof room>,
    revision: number,
  ) {
    return session.begin(request, A.participantId, A, null, roomStatus, revision, revision + 1, 0);
  }

  test('an ordinary play does not ask the player to move', () => {
    const session = new RoomSongCommandSession();
    const desired = desiredOf(session, begin(session, command('command-play-prov', 0, 'play'), room({ state: 2 }), 0));
    assert.equal(desired.state, 1);
    assert.equal(desired.mustApplyPosition, false);
  });

  test('an ordinary pause does not ask the player to move', () => {
    const session = new RoomSongCommandSession();
    const desired = desiredOf(session, begin(session, command('command-pause-prov', 0, 'pause'), room({ state: 1 }), 0));
    assert.equal(desired.state, 2);
    assert.equal(desired.mustApplyPosition, false);
  });

  test('a rate change does not ask the player to move', () => {
    const session = new RoomSongCommandSession();
    const request = command('command-rate-prov', 0, 'rate', { playbackRate: 1.25 });
    const desired = desiredOf(session, begin(session, request, room({ state: 1 }), 0));
    assert.equal(desired.playbackRate, 1.25);
    assert.equal(desired.mustApplyPosition, false);
  });

  test('an explicit seek does', () => {
    const session = new RoomSongCommandSession();
    const request = command('command-seek-prov', 0, 'seek', { positionSeconds: 120 });
    const desired = desiredOf(session, begin(session, request, room({ state: 1 }), 0));
    assert.equal(desired.positionSeconds, 120);
    assert.equal(desired.mustApplyPosition, true);
  });

  test('a load does', () => {
    const session = new RoomSongCommandSession();
    const request = command('command-load-prov', 0, 'load', { videoId: OTHER_VIDEO, positionSeconds: 30 });
    const desired = desiredOf(session, begin(session, request, room({ state: 1 }), 0));
    assert.equal(desired.positionSeconds, 30);
    assert.equal(desired.mustApplyPosition, true);
  });

  test('play against a finished song replays from the start and says so', () => {
    const session = new RoomSongCommandSession();
    const ended = room({ state: 0, serverTime: 206.6, youtubeTime: 206.6 });
    const desired = desiredOf(session, begin(session, command('command-replay-prov', 0, 'play'), ended, 0));
    assert.equal(desired.state, 1);
    assert.equal(desired.positionSeconds, 0);
    assert.equal(desired.mustApplyPosition, true);
  });

  test('a seek superseded before it reaches the player is inherited, not lost', () => {
    const session = new RoomSongCommandSession();
    const seek = begin(session, command('command-seek-prov-2', 0, 'seek', { positionSeconds: 120 }), room({ state: 1 }), 0);
    assert.equal(seek.ok, true);

    const play = session.begin(
      { ...command('command-play-prov-2', 1, 'play'), supersedesCommandId: 'command-seek-prov-2' },
      A.participantId,
      A,
      null,
      room({ state: 1 }),
      1,
      2,
      0,
    );
    const desired = desiredOf(session, play);
    assert.equal(desired.state, 1);
    assert.equal(desired.mustApplyPosition, true);
    assert.ok(Math.abs(desired.positionSeconds - 120) < 0.01);
  });
});

describe('room song telemetry command gate', () => {
  test('rejects direct identified semantic mutation without a room command', () => {
    const session = new RoomSongCommandSession();
    assert.deepEqual(session.gateTelemetry(telemetry({ state: 1 }), A, room(), 0), {
      ok: false,
      reason: 'command-required',
    });
    assert.deepEqual(session.gateTelemetry(telemetry({ currentTime: 50 }), A, room(), 0), {
      ok: false,
      reason: 'command-required',
    });
    assert.deepEqual(session.gateTelemetry(telemetry({ videoId: OTHER_VIDEO }), A, room(), 0), {
      ok: false,
      reason: 'command-required',
    });
  });

  test('a play command keeps BUFFERING intermediate and completes only on PLAYING', () => {
    const session = new RoomSongCommandSession();
    const accepted = session.begin(
      command('command-play-buffer', 0, 'play'),
      A.participantId,
      A,
      null,
      room({ state: 2 }),
      0,
      1,
      0,
    );
    assert.equal(accepted.ok, true);

    const buffering = session.gateTelemetry(
      telemetry({ state: 3, currentTime: 10.8 }),
      A,
      room({ state: 2, youtubeTime: 10, ageMs: 800 }),
      800,
    );
    assert.deepEqual(buffering, { ok: true });

    const playing = session.gateTelemetry(
      telemetry({ state: 1, currentTime: 10.9 }),
      A,
      room({ state: 2, youtubeTime: 10, ageMs: 900 }),
      900,
    );
    assert.deepEqual(playing, { ok: true, completesCommandId: 'command-play-buffer' });
  });

  test('ordinary Play can complete behind the room projection without becoming Seek', () => {
    const session = new RoomSongCommandSession();
    const accepted = session.begin(
      command('command-play-gap', 0, 'play'),
      A.participantId,
      A,
      null,
      room({ state: 2, serverTime: 98.199, youtubeTime: 97.386 }),
      0,
      1,
      0,
    );
    assert.equal(accepted.ok, true);

    assert.deepEqual(
      session.gateTelemetry(
        telemetry({ state: 1, currentTime: 97.7 }),
        A,
        room({ state: 2, serverTime: 98.199, youtubeTime: 97.386, ageMs: 300 }),
        300,
      ),
      { ok: true, completesCommandId: 'command-play-gap' },
    );
  });

  test('a simultaneous Play plus unrelated scrub cannot hide behind the Play command', () => {
    const session = new RoomSongCommandSession();
    session.begin(
      command('command-play-plus-seek', 0, 'play'),
      A.participantId,
      A,
      null,
      room({ state: 2 }),
      0,
      1,
      0,
    );

    assert.deepEqual(
      session.gateTelemetry(
        telemetry({ state: 1, currentTime: 50 }),
        A,
        room({ state: 2, youtubeTime: 10, ageMs: 100 }),
        100,
      ),
      { ok: false, reason: 'command-mismatch' },
    );
  });

  test('buffering does not absorb a report meant for a pause or a load', () => {
    const session = new RoomSongCommandSession();
    const accepted = session.begin(
      command('command-pause-buffer', 0, 'pause'),
      A.participantId,
      A,
      null,
      room({ state: 1 }),
      0,
      1,
      0,
    );
    assert.equal(accepted.ok, true);

    const gate = session.gateTelemetry(
      telemetry({ state: 3, currentTime: 10 }),
      A,
      room({ state: 1 }),
      0,
    );
    assert.notDeepEqual(gate, { ok: true, completesCommandId: 'command-pause-buffer' });
  });

  test('lets a committing handoff target report after its command expired', () => {
    const session = new RoomSongCommandSession();
    const committing = room({
      handoffState: 'committing',
      handoffTargetParticipantId: B.participantId,
      handoffTargetPlaybackTransportId: B.transportId,
      handoffTargetPlaybackGeneration: B.generation,
    });

    assert.deepEqual(
      session.gateTelemetry(telemetry({ videoId: OTHER_VIDEO, state: 2 }), B, committing, 0),
      { ok: true },
    );
    assert.deepEqual(
      session.gateTelemetry(telemetry({ videoId: OTHER_VIDEO, state: 2 }), A, committing, 0),
      { ok: false, reason: 'command-required' },
    );

    const preparing = room({
      handoffState: 'preparing',
      handoffTargetParticipantId: B.participantId,
      handoffTargetPlaybackTransportId: B.transportId,
      handoffTargetPlaybackGeneration: B.generation,
    });
    assert.deepEqual(
      session.gateTelemetry(telemetry({ videoId: OTHER_VIDEO, state: 2 }), B, preparing, 0),
      { ok: false, reason: 'command-required' },
    );
  });

  test('lets the leader re-anchor its own clock once its reports have gone stale', () => {
    const session = new RoomSongCommandSession();
    const stale = room({ connected: false, serverTime: 40, youtubeTime: 10, ageMs: 30_000 });
    assert.deepEqual(
      session.gateTelemetry(telemetry({ currentTime: 11 }), A, stale, 0),
      { ok: true },
    );

    assert.deepEqual(
      session.gateTelemetry(telemetry({ currentTime: 11 }), B, stale, 0),
      { ok: false, reason: 'command-required' },
    );

    for (const attemptedMutation of [
      telemetry({ videoId: OTHER_VIDEO, currentTime: 11 }),
      telemetry({ playbackRate: 1.25, currentTime: 11 }),
      telemetry({ state: 1, currentTime: 11 }),
    ]) {
      assert.deepEqual(
        session.gateTelemetry(attemptedMutation, A, stale, 0),
        { ok: false, reason: 'command-required' },
      );
    }

    assert.deepEqual(
      session.gateTelemetry(telemetry({ currentTime: 11 }), A, room(), 0),
      { ok: false, reason: 'command-required' },
    );
  });

  test('does not read a stalled player as an unrequested seek', () => {
    const session = new RoomSongCommandSession();
    const stalled = room({ state: 1, serverTime: 12, youtubeTime: 12, ageMs: 2_000 });
    assert.deepEqual(
      session.gateTelemetry(telemetry({ state: 1, currentTime: 10 }), A, stalled, 0),
      { ok: true },
    );
    assert.deepEqual(
      session.gateTelemetry(telemetry({ state: 1, currentTime: 5 }), A, stalled, 0),
      { ok: false, reason: 'command-required' },
    );
    assert.deepEqual(
      session.gateTelemetry(telemetry({ state: 1, currentTime: 20 }), A, stalled, 0),
      { ok: false, reason: 'command-required' },
    );
  });

  test('allows steady telemetry and buffering recovery without inventing commands', () => {
    const session = new RoomSongCommandSession();
    assert.deepEqual(session.gateTelemetry(telemetry({ currentTime: 10.2 }), A, room(), 0), { ok: true });
    assert.deepEqual(
      session.gateTelemetry(telemetry({ state: 1, currentTime: 10.2 }), A, room({ state: 3 }), 0),
      { ok: true },
    );
  });

  test('matching exact-target telemetry proves and completes the accepted command', () => {
    const session = new RoomSongCommandSession();
    const begun = session.begin(
      command('command-play-1', 0, 'play'),
      A.participantId,
      A,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.equal(begun.ok, true);

    assert.deepEqual(session.gateTelemetry(telemetry({ state: 1 }), B, room(), 100), {
      ok: false,
      reason: 'command-target-mismatch',
    });
    assert.deepEqual(session.gateTelemetry(telemetry({ state: 1 }), A, room(), 100), {
      ok: true,
      completesCommandId: 'command-play-1',
    });
    assert.equal(session.complete('command-play-1'), true);
  });

  test('rejects a different semantic mutation while a command is pending', () => {
    const session = new RoomSongCommandSession();
    session.begin(
      command('command-play-1', 0, 'play'),
      A.participantId,
      A,
      A.participantId,
      room(),
      0,
      1,
      0,
    );
    assert.deepEqual(session.gateTelemetry(telemetry({ currentTime: 50 }), A, room(), 100), {
      ok: false,
      reason: 'command-mismatch',
    });
  });

  test('keeps the narrow pre-participant publisher compatibility path', () => {
    const session = new RoomSongCommandSession();
    const legacy = {
      participantId: '__relay_legacy_publisher__',
      transportId: 'legacy-publisher-1',
      generation: 1,
    };
    assert.deepEqual(session.gateTelemetry(telemetry({ state: 1, currentTime: 50 }), legacy, room(), 0), {
      ok: true,
    });
  });
});
