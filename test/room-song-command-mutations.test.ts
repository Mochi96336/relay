import assert from 'node:assert/strict';
import test from 'node:test';

import {
  roomSongObservedMutations,
  roomSongPendingOwnsMutation,
} from '../public/room-song-command-mutations.js';

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
  });
  assert.deepEqual([...mutations], ['play', 'seek']);
});

test('BUFFERING progress may expose only the causal clock movement', () => {
  const mutations = roomSongObservedMutations({
    room,
    observed: observed({ state: 3, currentTime: 10.8 }),
  });
  assert.deepEqual([...mutations], ['seek']);

  assert.equal(roomSongPendingOwnsMutation({
    mutation: 'seek',
    commandAction: 'play',
    desired: { positionSeconds: 10, mustApplyPosition: false },
    currentTime: 10.8,
    projectedPositionSeconds: 10.8,
  }), true);
});

test('a state command does not own an unrelated scrub', () => {
  assert.equal(roomSongPendingOwnsMutation({
    mutation: 'seek',
    commandAction: 'play',
    desired: { positionSeconds: 10, mustApplyPosition: false },
    currentTime: 50,
    projectedPositionSeconds: 10.8,
  }), false);
});

test('an explicit Seek owns its position mutation', () => {
  assert.equal(roomSongPendingOwnsMutation({
    mutation: 'seek',
    commandAction: 'seek',
    desired: { positionSeconds: 120, mustApplyPosition: true },
    currentTime: 120,
    projectedPositionSeconds: 120,
  }), true);
});
