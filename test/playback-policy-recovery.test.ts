import assert from 'node:assert/strict';
import test from 'node:test';

import { canRecoverPlayback } from '../shared/playback-policy.js';

const LEFT_HOLDER = {
  playbackLeaderParticipantId: 'participant-d8183521',
  playbackTransportId: 'playback-1',
  playbackGeneration: 1,
  leaderConnected: false,
  leaderFresh: false,
  handoffState: 'idle',
};

test('a holder leaving mid-Song leaves playback to recover', () => {
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: { ...LEFT_HOLDER, state: 1 } }), true);
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: { ...LEFT_HOLDER, state: 2 } }), true);
});

test('an ended Song has nothing to recover once its holder leaves', () => {
  assert.equal(canRecoverPlayback({ role: 'observer', timeline: { ...LEFT_HOLDER, state: 0 } }), false);
});
