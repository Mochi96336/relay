import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEADER_HOLD_GRACE_MS,
  canChangeRoomSong,
  canRecoverPlayback,
  leaderHolding,
  playbackLeaderHealth,
} from '../public/playback-policy.js';

function timeline(overrides: Record<string, unknown> = {}) {
  return {
    playbackLeaderParticipantId: 'participant-a',
    playbackTransportId: 'playback-a',
    playbackGeneration: 1,
    leaderConnected: true,
    leaderFresh: true,
    ageMs: 250,
    handoffState: 'idle',
    ...overrides,
  };
}

test('alignment freshness and product hold grace remain separate facts', () => {
  const recentlyStale = timeline({ leaderFresh: false, ageMs: 2_000 });

  assert.equal(playbackLeaderHealth(recentlyStale), 'stale');
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: recentlyStale }), true);
  assert.equal(leaderHolding(recentlyStale), true);
});

test('product hold eventually releases after the longer continuity grace', () => {
  const expired = timeline({
    leaderFresh: false,
    ageMs: LEADER_HOLD_GRACE_MS + 1,
  });

  assert.equal(playbackLeaderHealth(expired), 'stale');
  assert.equal(leaderHolding(expired), false);
});

test('a disconnected leader never consumes the product hold grace', () => {
  const disconnected = timeline({
    leaderConnected: false,
    leaderFresh: false,
    ageMs: 500,
  });

  assert.equal(playbackLeaderHealth(disconnected), 'disconnected');
  assert.equal(leaderHolding(disconnected), false);
});

test('Mic owner can change the Song after the exact playback transport disappears', () => {
  const disconnected = timeline({
    videoId: 'abcdefghijk',
    leaderConnected: false,
    leaderFresh: false,
  });

  assert.equal(canChangeRoomSong({
    role: 'empty',
    timeline: disconnected,
    isMicOwner: true,
    isMicFree: false,
  }), true);
  assert.equal(canChangeRoomSong({
    role: 'empty',
    timeline: disconnected,
    isMicOwner: false,
    isMicFree: false,
  }), false);
});

test('Mic ownership does not bypass a healthy playback holder or active handoff', () => {
  assert.equal(canChangeRoomSong({
    role: 'observer',
    timeline: timeline({ videoId: 'abcdefghijk' }),
    isMicOwner: true,
    isMicFree: false,
  }), false);
  assert.equal(canChangeRoomSong({
    role: 'preparing',
    timeline: timeline({
      videoId: 'abcdefghijk',
      leaderConnected: false,
      leaderFresh: false,
      handoffState: 'preparing',
    }),
    isMicOwner: true,
    isMicFree: false,
  }), false);
});

test('everyone can change the Song while the Mic is free', () => {
  assert.equal(canChangeRoomSong({
    role: 'observer',
    timeline: timeline({ videoId: 'abcdefghijk' }),
    isMicOwner: false,
    isMicFree: true,
  }), true);
  assert.equal(canChangeRoomSong({
    role: 'empty',
    timeline: timeline({
      videoId: 'abcdefghijk',
      leaderConnected: false,
      leaderFresh: false,
    }),
    isMicOwner: false,
    isMicFree: true,
  }), true);
});

test('first Song selection follows the same Mic permission as replacement', () => {
  const empty = timeline({
    videoId: null,
    playbackLeaderParticipantId: null,
    playbackTransportId: null,
    playbackGeneration: null,
    leaderConnected: false,
    leaderFresh: false,
  });

  assert.equal(canChangeRoomSong({
    role: 'empty',
    timeline: empty,
    isMicOwner: false,
    isMicFree: true,
  }), true);
  assert.equal(canChangeRoomSong({
    role: 'empty',
    timeline: empty,
    isMicOwner: true,
    isMicFree: false,
  }), true);
  assert.equal(canChangeRoomSong({
    role: 'empty',
    timeline: empty,
    isMicOwner: false,
    isMicFree: false,
  }), false);
});

test('the exact holder retains the Change Song action while Mic projection reconnects', () => {
  assert.equal(canChangeRoomSong({
    role: 'holder',
    timeline: timeline({ videoId: 'abcdefghijk' }),
    isMicOwner: true,
    isMicFree: false,
  }), true);
  assert.equal(canChangeRoomSong({
    role: 'holder',
    timeline: timeline({ videoId: 'abcdefghijk' }),
    isMicOwner: false,
    isMicFree: false,
  }), true);
});
