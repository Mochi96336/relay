import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEADER_HOLD_GRACE_MS,
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
