import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS,
  ROOM_SONG_POSITION_TOLERANCE_SECONDS,
  ROOM_SONG_RATE_TOLERANCE,
} from '../public/room-song-command-convergence.js';
import {
  roomSongObservedMutations,
  roomSongPendingOwnsMutation,
  type RoomSongMutationThresholds,
} from '../src/room-song-command-mutations.js';

const thresholds: RoomSongMutationThresholds = {
  localJumpToleranceSeconds: ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS,
  positionToleranceSeconds: ROOM_SONG_POSITION_TOLERANCE_SECONDS,
  rateTolerance: ROOM_SONG_RATE_TOLERANCE,
};

const room = {
  videoId: 'dQw4w9WgXcQ',
  state: 2,
  youtubeTime: 10,
  ageMs: 800,
  playbackRate: 1,
};

function observed(overrides: Record<string, unknown> = {}) {
  return {
    videoId: room.videoId,
    state: 2,
    currentTime: 10,
    playbackRate: 1,
    ...overrides,
  };
}

test('one telemetry packet cannot hide a seek behind Play', () => {
  const mutations = roomSongObservedMutations({
    room,
    observed: observed({ state: 1, currentTime: 50 }),
    thresholds,
  });
  assert.deepEqual([...mutations], ['play', 'seek']);
});

test('BUFFERING progress may expose only the causal clock movement', () => {
  const mutations = roomSongObservedMutations({
    room,
    observed: observed({ state: 3, currentTime: 10.8 }),
    thresholds,
  });
  assert.deepEqual([...mutations], ['seek']);

  assert.equal(roomSongPendingOwnsMutation({
    mutation: 'seek',
    commandAction: 'play',
    desired: { positionSeconds: 10, mustApplyPosition: false },
    currentTime: 10.8,
    projectedPositionSeconds: 10.8,
    thresholds,
  }), true);
});

test('a state command does not own an unrelated scrub', () => {
  assert.equal(roomSongPendingOwnsMutation({
    mutation: 'seek',
    commandAction: 'play',
    desired: { positionSeconds: 10, mustApplyPosition: false },
    currentTime: 50,
    projectedPositionSeconds: 10.8,
    thresholds,
  }), false);
});

test('an explicit Seek owns its position mutation', () => {
  assert.equal(roomSongPendingOwnsMutation({
    mutation: 'seek',
    commandAction: 'seek',
    desired: { positionSeconds: 120, mustApplyPosition: true },
    currentTime: 120,
    projectedPositionSeconds: 120,
    thresholds,
  }), true);
});

test('mutation policy consumes caller thresholds instead of owning hidden constants', () => {
  const strictThresholds: RoomSongMutationThresholds = {
    localJumpToleranceSeconds: 0.1,
    positionToleranceSeconds: 0.1,
    rateTolerance: 0.001,
  };

  assert.deepEqual(
    [...roomSongObservedMutations({
      room,
      observed: observed({ currentTime: 10.2, playbackRate: 1.01 }),
      thresholds: strictThresholds,
    })],
    ['rate', 'seek'],
  );
});
