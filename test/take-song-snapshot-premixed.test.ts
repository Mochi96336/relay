import assert from 'node:assert/strict';
import test from 'node:test';
import { roomSongIsTakeBacking, takeSongSnapshotForMic } from '../src/take-song-snapshot.js';

const room = (state: number) => ({ videoId: 'dQw4w9WgXcQ', revision: 1, state, serverTime: 10, playbackRate: 1 });

test('a premixed Mic records the room YouTube song only while that song moves', () => {
  for (const state of [1, 3]) assert.equal(roomSongIsTakeBacking(room(state), true), true, `state ${state}`);
  for (const state of [5, 2, 0, -1]) assert.equal(roomSongIsTakeBacking(room(state), true), false, `state ${state}`);
  for (const state of [1, 5, 2]) assert.equal(roomSongIsTakeBacking(room(state), false), true, 'no premix: any loaded song');
  assert.equal(roomSongIsTakeBacking({ videoId: null, state: null }, false), false);
});

test('a local file Take under a cued video names the file, not the video', () => {
  const localFile = { title: 'Piano', heard: true };
  assert.deepEqual(takeSongSnapshotForMic(room(5), localFile), {
    videoId: null, revision: null, state: null, serverTime: null, playbackRate: null, localFile,
  });
  assert.equal(takeSongSnapshotForMic(room(1), localFile).videoId, 'dQw4w9WgXcQ');
  assert.deepEqual(takeSongSnapshotForMic(room(5), null), {
    videoId: 'dQw4w9WgXcQ', revision: 1, state: 5, serverTime: 10, playbackRate: 1,
  });
});
