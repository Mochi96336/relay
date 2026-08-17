import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { SongSession, normalizePlaybackGeneration } from '../src/song-session.js';

const VIDEO = 'dQw4w9WgXcQ';
const UINT32_MAX = 0xffff_ffff;

function telemetry(currentTime = 10) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
  };
}

test('playback generations use the JS safe-integer range instead of wrapping at uint32', () => {
  assert.equal(normalizePlaybackGeneration(UINT32_MAX), UINT32_MAX);
  assert.equal(normalizePlaybackGeneration(UINT32_MAX + 1), UINT32_MAX + 1);
  assert.equal(normalizePlaybackGeneration(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);

  assert.equal(normalizePlaybackGeneration(-1), null);
  assert.equal(normalizePlaybackGeneration(1.5), null);
  assert.equal(normalizePlaybackGeneration(Number.MAX_SAFE_INTEGER + 1), null);
});

test('a post-uint32 generation still replaces the older incarnation of the same tab', () => {
  const songs = new SongSession();
  const oldPage = {
    participantId: 'participant-a',
    transportId: 'playback-tab-a',
    generation: UINT32_MAX,
  };
  const reloadedPage = {
    ...oldPage,
    generation: UINT32_MAX + 1,
  };

  assert.equal(songs.update(telemetry(10), oldPage, null, 0).accepted, true);
  const replaced = songs.update(telemetry(11), reloadedPage, null, 100);
  assert.equal(replaced.accepted, true);
  assert.equal(replaced.leaderChanged, true);
  assert.equal(
    (songs.statusPayload(100) as Record<string, unknown>).playbackGeneration,
    UINT32_MAX + 1,
  );
});

test('browser generation is a persisted monotonic counter, not a truncated clock', async () => {
  const source = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(source, /PLAYBACK_GENERATION_KEY\s*=\s*'relay\.playbackGeneration\.v1'/);
  assert.match(source, /function nextPlaybackGeneration\(\)/);
  assert.match(source, /sessionStorage\.getItem\(PLAYBACK_GENERATION_KEY\)/);
  assert.match(source, /Math\.max\(previous \+ 1, wallClock\)/);
  assert.match(source, /sessionStorage\.setItem\(PLAYBACK_GENERATION_KEY, String\(generation\)\)/);
  assert.match(source, /Number\.MAX_SAFE_INTEGER/);
  assert.doesNotMatch(source, /Date\.now\(\)\s*>>>\s*0/);
});
