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
