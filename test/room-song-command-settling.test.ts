import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
    state: 2,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    timelineDeltaSeconds: 0,
    ...overrides,
  };
}

test('state-only Play stays pending across the observed +813ms / -833ms iframe correction', () => {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    command('command-play-settle', 0, 'play'),
    A.participantId,
    A,
    null,
    room({ state: 2, serverTime: 98.199, youtubeTime: 97.386 }),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);

  // PAUSED -> PLAYING does not project natural motion from the previous sample,
  // so the observed 97.386 -> 98.199 edge reaches the wire as +813 ms.
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 98.199, timelineDeltaSeconds: 0.813 }),
      A,
      room({ state: 2, serverTime: 98.199, youtubeTime: 97.386, ageMs: 300 }),
      300,
    ),
    { ok: true },
  );

  // Once PLAYING, readSnapshot subtracts natural media-clock advance. A raw
  // +305 ms step over roughly 300 ms is therefore essentially stable residual.
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 98.504, timelineDeltaSeconds: 0.005 }),
      A,
      room({ state: 1, serverTime: 98.449, youtubeTime: 98.199, ageMs: 250 }),
      550,
    ),
    { ok: true },
  );

  // The raw 98.504 -> 97.671 correction is -833 ms. After subtracting the
  // roughly 300 ms the playing clock should have advanced, the actual wire
  // residual is about -1.13 s: still inside the client's causal correction
  // envelope, but intentionally too unstable to retire command provenance.
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 97.671, timelineDeltaSeconds: -1.133 }),
      A,
      room({ state: 1, serverTime: 98.804, youtubeTime: 98.504, ageMs: 300 }),
      850,
    ),
    { ok: true },
  );
  assert.equal(session.statusPayload(1, 850).pendingCommandId, 'command-play-settle');

  // Only after the media clock demonstrates stable continuity twice does the
  // state-only command become terminal.
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 97.921, timelineDeltaSeconds: 0 }),
      A,
      room({ state: 1, serverTime: 97.921, youtubeTime: 97.671, ageMs: 250 }),
      1_100,
    ),
    { ok: true },
  );
  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 1, currentTime: 98.171, timelineDeltaSeconds: 0 }),
      A,
      room({ state: 1, serverTime: 98.171, youtubeTime: 97.921, ageMs: 250 }),
      1_350,
    ),
    { ok: true, completesCommandId: 'command-play-settle' },
  );
});

test('position-bearing Seek still completes from one full positional proof', () => {
  const session = new RoomSongCommandSession();
  const begun = session.begin(
    command('command-seek-strong-proof', 0, 'seek', { positionSeconds: 80 }),
    A.participantId,
    A,
    null,
    room({ state: 2 }),
    0,
    1,
    0,
  );
  assert.equal(begun.ok, true);

  assert.deepEqual(
    session.gateTelemetry(
      telemetry({ state: 2, currentTime: 80, timelineDeltaSeconds: 70 }),
      A,
      room({ state: 2, youtubeTime: 10 }),
      100,
    ),
    { ok: true, completesCommandId: 'command-seek-strong-proof' },
  );
});

test('production YouTube telemetry carries the local clock residual used by convergence', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const dispatchStart = source.indexOf("new CustomEvent('relay:youtube-telemetry'");
  assert.ok(dispatchStart >= 0, 'YouTube telemetry dispatch is missing');
  const dispatchSection = source.slice(dispatchStart, dispatchStart + 700);
  assert.match(dispatchSection, /timelineDeltaSeconds:\s*snapshot\.timelineDeltaSeconds/);

  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  const forwardStart = sync.indexOf("window.addEventListener('relay:youtube-telemetry'");
  assert.ok(forwardStart >= 0, 'YouTube telemetry forwarder is missing');
  const forwardSection = sync.slice(forwardStart, forwardStart + 700);
  assert.match(forwardSection, /type:\s*'youtube-telemetry'/);
  assert.match(forwardSection, /\.\.\.detail/);
});
