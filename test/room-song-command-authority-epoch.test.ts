import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandSession } from '../src/room-song-command-session.js';

const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';

function request(commandId: string) {
  const parsed = parseRoomSongCommand({
    commandId,
    expectedRevision: 0,
    action: 'seek',
    positionSeconds: 30,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid test request');
  return parsed.request;
}

function room() {
  return {
    videoId: VIDEO,
    state: 1,
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
  };
}

test('authority epoch cancellation returns the pending command without rewinding revision history', () => {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    request('command-seek-epoch'),
    A.participantId,
    A,
    A.participantId,
    room(),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);

  const cancelled = session.cancelPending();
  assert.equal(cancelled?.commandId, 'command-seek-epoch');
  assert.equal(cancelled?.revision, 1);
  assert.deepEqual(cancelled?.target, A);
  assert.equal(session.pendingForTarget(A, 10), null);

  // The accepted command remains historical evidence, but it is no longer a
  // live proof target once Mic authority enters another epoch.
  assert.deepEqual(session.gateTelemetry({
    videoId: VIDEO,
    state: 1,
    currentTime: 30,
    playbackRate: 1,
  }, A, room(), 20), {
    ok: false,
    reason: 'command-required',
  });
});

test('cancelling an idle command session is a no-op', () => {
  const session = new RoomSongCommandSession();
  assert.equal(session.cancelPending(), null);
});
