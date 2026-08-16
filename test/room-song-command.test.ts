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

describe('room song command parser', () => {
  test('accepts load, transport and rate commands', () => {
    assert.deepEqual(
      command('command-load-1', 0, 'load', { videoId: VIDEO, positionSeconds: 12 }),
      {
        commandId: 'command-load-1',
        expectedRevision: 0,
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

  test('keeps 1A serial: a second intent cannot replace a pending command yet', () => {
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
