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

test('the apply path never lets a player read break the command', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  const applySection = source.slice(applyStart, applyEnd);

  // The whole apply runs inside one try whose catch fails the command, so a
  // read that throws would skip playVideo() and report a failure - worse than
  // the unconditional call the read exists to avoid.
  assert.doesNotMatch(applySection, /player\.getPlaybackRate\(\)/);

  for (const helper of ['function safePlaybackRate()']) {
    const start = source.indexOf(helper);
    assert.ok(start >= 0, `${helper} is missing`);
    assert.match(source.slice(start, start + 320), /try \{[\s\S]*\} catch \{/);
  }
});
