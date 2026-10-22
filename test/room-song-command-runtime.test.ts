import assert from 'node:assert/strict';
import test from 'node:test';

import { parseRoomSongCommand } from '../src/room-song-command.js';
import { RoomSongCommandRuntime } from '../src/room-song-command-runtime.js';

const A = { participantId: 'participant-a', transportId: 'playback-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-b', generation: 1 };
const VIDEO = 'dQw4w9WgXcQ';

function request(commandId: string, expectedRevision: number, action: string) {
  const parsed = parseRoomSongCommand({ commandId, expectedRevision, action });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid command fixture');
  return parsed.request;
}

function room() {
  return {
    type: 'youtube-timeline-status',
    videoId: VIDEO,
    state: 2,
    serverTime: 10,
    playbackRate: 1,
    playbackLeaderParticipantId: A.participantId,
    playbackTransportId: A.transportId,
    playbackGeneration: A.generation,
    connected: true,
    leaderConnected: true,
    leaderFresh: true,
    handoffState: 'idle',
  };
}

test('RoomSongCommandRuntime owns revision allocation around accepted commands', () => {
  const runtime = new RoomSongCommandRuntime();
  assert.equal(runtime.revision, 0);
  assert.equal(runtime.statusPayload(0).revision, 0);

  const accepted = runtime.begin(
    request('command-play-1', 0, 'play'),
    A.participantId,
    A,
    A.participantId,
    room(),
    0,
  );
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.command.revision, 1);
  assert.equal(runtime.revision, 1);
  assert.equal(runtime.statusPayload(1).revision, 1);
});

test('rejected and duplicate commands never allocate another revision', () => {
  const runtime = new RoomSongCommandRuntime();
  const command = request('command-play-2', 0, 'play');

  const rejected = runtime.begin(command, B.participantId, B, A.participantId, room(), 0);
  assert.deepEqual(rejected, { ok: false, reason: 'mic-owner-required' });
  assert.equal(runtime.revision, 0);

  const accepted = runtime.begin(command, A.participantId, A, A.participantId, room(), 1);
  assert.equal(accepted.ok, true);
  assert.equal(runtime.revision, 1);

  const duplicate = runtime.begin(command, A.participantId, A, A.participantId, room(), 2);
  assert.equal(duplicate.ok, true);
  if (!duplicate.ok) return;
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.command.revision, 1);
  assert.equal(runtime.revision, 1);
});

test('terminal completion keeps the committed revision and the next command advances once', () => {
  const runtime = new RoomSongCommandRuntime();
  const first = runtime.begin(
    request('command-play-3', 0, 'play'),
    A.participantId,
    A,
    A.participantId,
    room(),
    0,
  );
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(runtime.complete(first.command.commandId), true);
  assert.equal(runtime.revision, 1);

  const second = runtime.begin(
    request('command-pause-3', 1, 'pause'),
    A.participantId,
    A,
    A.participantId,
    room(),
    10,
  );
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.command.revision, 2);
  assert.equal(runtime.revision, 2);
});

test('Mic owner replacement atomically retires a pending command after checking revision', () => {
  const runtime = new RoomSongCommandRuntime();
  const first = runtime.begin(request('old-command', 0, 'play'), A.participantId, A, A.participantId, room(), 0);
  assert.equal(first.ok, true);
  const parsed = parseRoomSongCommand({ commandId: 'new-song-load', expectedRevision: 0, action: 'load', videoId: VIDEO });
  assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const status = { ...room(), handoffState: 'preparing' };
  const stale = runtime.begin(parsed.request, B.participantId, B, B.participantId, status, 10);
  assert.deepEqual(stale, { ok: false, reason: 'stale-revision' });
  assert.equal(runtime.pendingForTarget(A, 10)?.commandId, 'old-command');
  const next = runtime.begin({ ...parsed.request, expectedRevision: 1 }, B.participantId, B, B.participantId, status, 20);
  assert.equal(next.ok, true); if (!next.ok) return;
  assert.equal(next.replacedCommandId, 'old-command');
  assert.deepEqual(next.command.target, B);
  assert.equal(runtime.pendingForTarget(A, 20), null);
  assert.equal(runtime.pendingForTarget(B, 20)?.commandId, 'new-song-load');
});

test('Play on a parked paused controller applies its logical position explicitly', () => {
  const runtime = new RoomSongCommandRuntime();
  const begun = runtime.begin(request('play-parked', 0, 'play'), A.participantId, A, A.participantId,
    { ...room(), state: 2, serverTime: 198, playbackParked: true }, 0);
  assert.equal(begun.ok, true); if (!begun.ok) return;
  assert.equal(begun.command.body.desired.positionSeconds, 198);
  assert.equal(begun.command.body.desired.mustApplyPosition, true);
});
