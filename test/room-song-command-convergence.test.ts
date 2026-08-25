import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS,
  roomSongCommandConvergence,
  roomSongCommandLocalDeltaEvidence,
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

test('observed Play discontinuity creates only the correction debt needed by the live +813/-833 sequence', () => {
  const transition = roomSongCommandLocalDeltaEvidence({
    desired,
    timelineDeltaSeconds: 0.813,
    elapsedSinceApplySeconds: 0.3,
    commandTransition: true,
  });
  assert.deepEqual(transition, {
    explained: true,
    correctionDebtSeconds: 0.813,
  });

  // A stable sample does not invent more authority, but it also cannot erase
  // the debt before YouTube has had a chance to correct the transition edge.
  const stable = roomSongCommandLocalDeltaEvidence({
    desired,
    timelineDeltaSeconds: 0.005,
    elapsedSinceApplySeconds: 0.55,
    correctionDebtSeconds: transition.correctionDebtSeconds,
  });
  assert.deepEqual(stable, {
    explained: true,
    correctionDebtSeconds: 0.813,
  });

  // The observed raw 98.504 -> 97.671 correction is -833 ms. Because normal
  // PLAYING advance is already subtracted, the wire residual is about -1.133 s.
  const correction = roomSongCommandLocalDeltaEvidence({
    desired,
    timelineDeltaSeconds: -1.133,
    elapsedSinceApplySeconds: 0.85,
    correctionDebtSeconds: stable.correctionDebtSeconds,
  });
  assert.deepEqual(correction, {
    explained: true,
    correctionDebtSeconds: 0,
  });
});

test('stable pending Play does not absorb a medium native scrub merely because command age grew', () => {
  for (const timelineDeltaSeconds of [1, -1]) {
    assert.deepEqual(
      roomSongCommandLocalDeltaEvidence({
        desired,
        timelineDeltaSeconds,
        elapsedSinceApplySeconds: 0.8,
        commandTransition: false,
        correctionDebtSeconds: 0,
      }),
      { explained: false, correctionDebtSeconds: 0 },
    );
  }

  assert.deepEqual(
    roomSongCommandLocalDeltaEvidence({
      desired,
      timelineDeltaSeconds: 1,
      elapsedSinceApplySeconds: 3,
      commandTransition: false,
      correctionDebtSeconds: 0,
    }),
    { explained: false, correctionDebtSeconds: 0 },
    'waiting longer must not grow Play position authority',
  );
});

test('a correction debt only authorizes motion opposite the observed command discontinuity', () => {
  assert.deepEqual(
    roomSongCommandLocalDeltaEvidence({
      desired,
      timelineDeltaSeconds: 1,
      elapsedSinceApplySeconds: 0.8,
      correctionDebtSeconds: 0.813,
    }),
    { explained: false, correctionDebtSeconds: 0.813 },
  );
});

test('an implausibly large transition jump still escapes command provenance', () => {
  assert.deepEqual(
    roomSongCommandLocalDeltaEvidence({
      desired,
      timelineDeltaSeconds: 4,
      elapsedSinceApplySeconds: 0.3,
      commandTransition: true,
    }),
    { explained: false, correctionDebtSeconds: 0 },
  );
});

test('state-only paused commands retain only the ordinary local continuity bound', () => {
  assert.deepEqual(
    roomSongCommandLocalDeltaEvidence({
      desired: { ...desired, state: 2 },
      timelineDeltaSeconds: ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS + 0.01,
      elapsedSinceApplySeconds: 3,
    }),
    { explained: false, correctionDebtSeconds: 0 },
  );
});
