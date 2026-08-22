import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  ROOM_SONG_SEEK_TOLERANCE_SECONDS,
  shouldSeekForRoomCommand,
} from '../public/room-song-seek-policy.js';

test('resuming a song that is already where the room wants it does not reposition the player', () => {
  assert.equal(
    shouldSeekForRoomCommand({
      action: 'play',
      currentSeconds: 61.02,
      desiredSeconds: 61.0,
    }),
    false,
    'a seek costs a visible re-buffer even when it lands where the player already is',
  );

  // The carried position is the room clock's prediction, and a player that
  // re-buffered sits behind it without anyone having seeked.
  assert.equal(
    shouldSeekForRoomCommand({
      action: 'play',
      currentSeconds: 60.7,
      desiredSeconds: 61.0,
    }),
    false,
  );
  assert.equal(
    shouldSeekForRoomCommand({
      action: 'pause',
      currentSeconds: 61.3,
      desiredSeconds: 61.0,
    }),
    false,
  );
});

test('a gap worth more than the stutter still repositions the player', () => {
  assert.equal(
    shouldSeekForRoomCommand({
      action: 'play',
      currentSeconds: 61.0,
      desiredSeconds: 63.5,
    }),
    true,
  );
  assert.equal(
    shouldSeekForRoomCommand({
      action: 'play',
      currentSeconds: 63.5,
      desiredSeconds: 61.0,
    }),
    true,
  );

  const justOver = ROOM_SONG_SEEK_TOLERANCE_SECONDS + 0.01;
  assert.equal(
    shouldSeekForRoomCommand({ action: 'play', currentSeconds: 0, desiredSeconds: justOver }),
    true,
  );
  assert.equal(
    shouldSeekForRoomCommand({
      action: 'play',
      currentSeconds: 0,
      desiredSeconds: ROOM_SONG_SEEK_TOLERANCE_SECONDS,
    }),
    false,
    'the tolerance is inclusive, so the boundary itself is not worth a stutter',
  );
});

test('commands whose whole purpose is to position the player always do', () => {
  for (const action of ['load', 'seek']) {
    assert.equal(
      shouldSeekForRoomCommand({ action, currentSeconds: 61.0, desiredSeconds: 61.0 }),
      true,
      `${action} must position the player even when the numbers already agree`,
    );
  }

  assert.equal(
    shouldSeekForRoomCommand({
      action: 'play',
      videoChanged: true,
      currentSeconds: 61.0,
      desiredSeconds: 61.0,
    }),
    true,
    'a freshly cued video has no comparable current position',
  );
});

test('an unreadable player position falls back to positioning it', () => {
  for (const currentSeconds of [Number.NaN, undefined, null, -1, 'soon']) {
    assert.equal(
      shouldSeekForRoomCommand({ action: 'play', currentSeconds, desiredSeconds: 61.0 }),
      true,
      `${String(currentSeconds)} is not evidence that the gap is small`,
    );
  }
});

test('an unusable target position is not a reason to move the player', () => {
  for (const desiredSeconds of [Number.NaN, undefined, null, -1]) {
    assert.equal(
      shouldSeekForRoomCommand({ action: 'play', currentSeconds: 61.0, desiredSeconds }),
      false,
      `${String(desiredSeconds)} names nowhere to seek to`,
    );
  }
});

test('the room command apply path consults the policy instead of seeking unconditionally', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart, 'server apply helper is missing');
  const applySection = source.slice(applyStart, applyEnd);

  assert.match(applySection, /shouldSeekForRoomCommand\(\{/);
  assert.doesNotMatch(
    applySection,
    /\n\s*player\.seekTo\(Math\.max\(0, desired\.positionSeconds\), true\);\n\s*player\.setPlaybackRate/,
    'the seek must sit behind the policy, not run before every rate change',
  );
});
