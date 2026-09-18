import assert from 'node:assert/strict';
import test from 'node:test';

import { canRecoverPlayback, playbackLeaderHealth } from '../public/playback-recovery.js';
import { SongSession } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const A = { participantId: 'participant-a', transportId: 'playback-tab-a', generation: 1 };
const B = { participantId: 'participant-b', transportId: 'playback-tab-b', generation: 1 };

function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    ...overrides,
  };
}

function observerCanRecover(songs: SongSession, nowMs: number) {
  const timeline = songs.statusPayload(nowMs) as Record<string, unknown>;
  return {
    health: playbackLeaderHealth(timeline),
    recoverable: canRecoverPlayback({ role: 'observer', timeline }),
  };
}

test('browser and server both keep a healthy playback leader authoritative', () => {
  const songs = new SongSession();
  songs.update(telemetry(), A, null, 0);

  assert.deepEqual(observerCanRecover(songs, 250), {
    health: 'healthy',
    recoverable: false,
  });

  const replacement = songs.update(telemetry({ currentTime: 30 }), B, null, 250);
  assert.equal(replacement.accepted, false);
  assert.equal(replacement.reason, 'leader-busy');
});

test('browser and server both release authority after leader disconnect', () => {
  const songs = new SongSession();
  songs.update(telemetry(), A, null, 0);
  songs.detach(A);

  assert.deepEqual(observerCanRecover(songs, 100), {
    health: 'disconnected',
    recoverable: true,
  });

  const replacement = songs.update(telemetry({ currentTime: 30 }), B, null, 100);
  assert.equal(replacement.accepted, true);
  assert.equal(replacement.leaderChanged, true);
});

test('browser and server both release authority after leader freshness expires', () => {
  const songs = new SongSession();
  songs.update(telemetry(), A, null, 0);

  assert.deepEqual(observerCanRecover(songs, 1_501), {
    health: 'stale',
    recoverable: true,
  });

  const replacement = songs.update(telemetry({ currentTime: 30 }), B, null, 1_501);
  assert.equal(replacement.accepted, true);
  assert.equal(replacement.leaderChanged, true);
});

test('fresh packets from a frozen PLAYING clock release browser and server authority together', () => {
  const songs = new SongSession();
  assert.equal(songs.update(telemetry(), A, null, 0).accepted, true);

  for (let nowMs = 250; nowMs <= 2_000; nowMs += 250) {
    assert.equal(
      songs.update(telemetry({ timelineDeltaSeconds: -0.25 }), A, null, nowMs).accepted,
      true,
    );
  }

  const stalled = songs.statusPayload(2_000) as Record<string, any>;
  assert.equal(stalled.telemetryAgeMs, 0, 'the old leader transport is still reporting');
  assert.equal(stalled.clockAgeMs, 2_000, 'the PLAYING media clock itself has not moved');
  assert.equal(stalled.connected, false, 'room clock authority is stale');
  assert.equal(stalled.leaderFresh, false, 'leader authority must follow media-clock freshness');
  assert.deepEqual(observerCanRecover(songs, 2_000), {
    health: 'stale',
    recoverable: true,
  });

  const replacement = songs.update(
    telemetry({ currentTime: 12, timelineDeltaSeconds: 0 }),
    B,
    null,
    2_000,
  );
  assert.equal(replacement.accepted, true, 'server must release the same stale authority');
  assert.equal(replacement.leaderChanged, true);
});

test('fresh PAUSED telemetry keeps leader authority without media-position progress', () => {
  const songs = new SongSession();
  assert.equal(songs.update(telemetry({ state: 2 }), A, null, 0).accepted, true);

  for (let nowMs = 250; nowMs <= 2_000; nowMs += 250) {
    assert.equal(songs.update(telemetry({ state: 2 }), A, null, nowMs).accepted, true);
  }

  const paused = songs.statusPayload(2_000) as Record<string, any>;
  assert.equal(paused.connected, true);
  assert.equal(paused.leaderFresh, true);
  assert.deepEqual(observerCanRecover(songs, 2_000), {
    health: 'healthy',
    recoverable: false,
  });

  const replacement = songs.update(telemetry({ state: 2, currentTime: 30 }), B, null, 2_000);
  assert.equal(replacement.accepted, false);
  assert.equal(replacement.reason, 'leader-busy');
});
