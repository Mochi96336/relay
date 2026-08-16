import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canRecoverPlayback,
  playbackLeaderHealth,
  shouldForceMuteListen,
} from '../public/playback-recovery.js';

function timeline(overrides: Record<string, unknown> = {}) {
  return {
    videoId: 'abcdefghijk',
    state: 1,
    handoffState: 'idle',
    playbackLeaderParticipantId: 'participant-a',
    playbackTransportId: 'playback-a',
    playbackGeneration: 1,
    leaderConnected: true,
    leaderFresh: true,
    ...overrides,
  };
}

test('healthy playback leader keeps observers read-only', () => {
  const status = timeline();
  assert.equal(playbackLeaderHealth(status), 'healthy');
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: status }), false);
});

test('disconnected playback leader becomes recoverable', () => {
  const status = timeline({ leaderConnected: false });
  assert.equal(playbackLeaderHealth(status), 'disconnected');
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: status }), true);
});

test('stale playback leader becomes recoverable even while its identity remains', () => {
  const status = timeline({ leaderFresh: false });
  assert.equal(playbackLeaderHealth(status), 'stale');
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: status }), true);
});

test('a room song with no playback leader can be recovered', () => {
  const status = timeline({
    playbackLeaderParticipantId: null,
    playbackTransportId: null,
    playbackGeneration: null,
    leaderConnected: false,
    leaderFresh: false,
  });
  assert.equal(playbackLeaderHealth(status), 'missing');
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: status }), true);
});

test('active handoff is never bypassed by recovery UI', () => {
  const status = timeline({ leaderFresh: false, handoffState: 'preparing' });
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: status }), false);
});

test('Listen mutes only for healthy local playback that is playing or buffering', () => {
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 1 }) }), true);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 3 }) }), true);
  assert.equal(shouldForceMuteListen({ role: 'preparing', timeline: timeline({ state: 1 }) }), true);
});

test('paused, ended, stale and disconnected holders do not keep Listen locked', () => {
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 2 }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ state: 0 }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ leaderFresh: false }) }), false);
  assert.equal(shouldForceMuteListen({ role: 'holder', timeline: timeline({ leaderConnected: false }) }), false);
});

test('observer never force-mutes Listen just because the room song is playing', () => {
  assert.equal(shouldForceMuteListen({ role: 'observer', timeline: timeline({ state: 1 }) }), false);
});
