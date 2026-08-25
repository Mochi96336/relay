import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('recoverable Song copy is owned by the Live i18n provider', () => {
  const song = read('public/song-surface.js');
  const liveCopy = read('public/live-i18n.js');

  assert.match(song, /import '\.\/live-i18n\.js';/);
  assert.match(song, /t\('song\.playbackControllerUnavailable'\)/);
  assert.match(song, /t\('song\.playbackInterrupted'\)/);
  assert.doesNotMatch(song, /function localCopy|relayI18n\?\.getLocale/,
    'Song presenter must not own a second bilingual recovery dictionary');

  for (const key of [
    'song.playbackControllerUnavailable',
    'song.playbackInterrupted',
  ]) {
    assert.equal((liveCopy.match(new RegExp(`'${key.replaceAll('.', '\\.')}':`, 'g')) ?? []).length, 2, key);
  }

  assert.match(liveCopy, /'song\.playbackControllerUnavailable': 'Playback controller unavailable'/);
  assert.match(liveCopy, /'song\.playbackControllerUnavailable': '播放主控已失聯'/);
  assert.match(liveCopy, /'song\.playbackInterrupted': 'Playback interrupted'/);
  assert.match(liveCopy, /'song\.playbackInterrupted': '播放已中斷'/);
});

test('Song recovery policy stays outside copy ownership', () => {
  const song = read('public/song-surface.js');
  const policy = read('public/playback-policy.js');

  assert.match(song, /canRecoverPlayback\(\{ role: nextRole, timeline: room \}\)/);
  assert.match(policy, /health === 'missing' \|\| health === 'disconnected' \|\| health === 'stale'/);
  assert.doesNotMatch(policy, /relayI18n|playbackControllerUnavailable|playbackInterrupted/,
    'playback policy must remain semantic and copy-free');
});
