import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS,
  roomSongCommandConvergence,
  roomSongCommandExplainsLocalDelta,
} from '../public/room-song-command-convergence.js';

const desired = {
  videoId: 'dQw4w9WgXcQ',
  positionSeconds: 98.199,
  state: 1,
  playbackRate: 1,
  mustApplyPosition: false,
};

function observed(overrides: Record<string, unknown> = {}) {
  return {
    videoId: desired.videoId,
    currentTime: 97.386,
    state: 1,
    playbackRate: 1,
    ...overrides,
  };
}

test('ordinary Play converges by commanded dimensions, not room projection', () => {
  assert.equal(
    roomSongCommandConvergence({ desired, observed: observed() }),
    'complete',
  );
});

test('BUFFERING is authorized progress but never completes Play', () => {
  assert.equal(
    roomSongCommandConvergence({ desired, observed: observed({ state: 3 }) }),
    'intermediate',
  );
});

test('a position-bearing command still requires position convergence', () => {
  assert.equal(
    roomSongCommandConvergence({
      desired: { ...desired, mustApplyPosition: true },
      observed: observed(),
    }),
    'complete',
    'the live 813 ms gap stays inside the positional proof tolerance',
  );

  assert.equal(
    roomSongCommandConvergence({
      desired: { ...desired, mustApplyPosition: true, positionSeconds: 120 },
      observed: observed(),
    }),
    'none',
  );
});

test('Play-caused forward motion and the following 833 ms clock correction stay causal', () => {
  assert.equal(
    roomSongCommandExplainsLocalDelta({
      desired,
      timelineDeltaSeconds: 0.813,
      elapsedSinceApplySeconds: 0.3,
    }),
    true,
  );
  assert.equal(
    roomSongCommandExplainsLocalDelta({
      desired,
      timelineDeltaSeconds: -0.833,
      elapsedSinceApplySeconds: 0.6,
    }),
    true,
  );

  assert.equal(
    roomSongCommandExplainsLocalDelta({
      desired,
      timelineDeltaSeconds: 4,
      elapsedSinceApplySeconds: 0.3,
    }),
    false,
  );
  assert.equal(
    roomSongCommandExplainsLocalDelta({
      desired,
      timelineDeltaSeconds: -2,
      elapsedSinceApplySeconds: 0.6,
    }),
    false,
  );
});

test('state-only commands never get an unlimited local seek grace', () => {
  assert.equal(
    roomSongCommandExplainsLocalDelta({
      desired: { ...desired, state: 2 },
      timelineDeltaSeconds: ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS + 0.01,
      elapsedSinceApplySeconds: 3,
    }),
    false,
  );
});
