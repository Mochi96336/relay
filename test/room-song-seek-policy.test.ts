import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { shouldSetPlaybackRate } from '../public/room-song-seek-policy.js';

test('a command does not re-assert a playback rate the player already has', () => {
  assert.equal(shouldSetPlaybackRate({ currentRate: 1, desiredRate: 1 }), false);
  assert.equal(shouldSetPlaybackRate({ currentRate: 1.25, desiredRate: 1.25 }), false);
});

test('a real rate change is still applied', () => {
  assert.equal(shouldSetPlaybackRate({ currentRate: 1, desiredRate: 1.25 }), true);
  assert.equal(shouldSetPlaybackRate({ currentRate: 1.25, desiredRate: 1 }), true);
});

test('an unreadable current rate is not evidence that it already matches', () => {
  for (const currentRate of [Number.NaN, undefined, null, 0, -1, 'normal']) {
    assert.equal(
      shouldSetPlaybackRate({ currentRate, desiredRate: 1 }),
      true,
      `${String(currentRate)} says nothing about the rate in force`,
    );
  }
});

test('an unusable desired rate is never applied', () => {
  for (const desiredRate of [Number.NaN, undefined, null, 0, -1, 'fast']) {
    assert.equal(shouldSetPlaybackRate({ currentRate: 1, desiredRate }), false);
  }
});

test('the shared iframe adapter tolerates an unreadable current rate', async () => {
  const source = await readFile(new URL('../public/youtube-playback-target.js', import.meta.url), 'utf8');
  assert.match(source, /try \{ rate = Number\(player\.getPlaybackRate\?\.\(\)\); \} catch \{\}/);
  assert.match(source, /shouldSetPlaybackRate\(\{ currentRate: rate, desiredRate: desired\.playbackRate \}\)/);
});
