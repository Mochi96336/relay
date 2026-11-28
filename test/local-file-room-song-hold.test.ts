import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { roomSongHoldsLocalFile } from '../public/local-file-mix.js';

const ui = await readFile(new URL('../public/local-file-ui.js', import.meta.url), 'utf8');

test('while the room song plays, the local file cannot start again and says why', () => {
  assert.match(ui, /const heldByRoom = roomSongPlaying && !playing;/);
  assert.match(ui, /playButton\.disabled = !playing && \(!ready \|\| heldByRoom\);/);
  assert.match(ui, /heldByRoom \? t\('localFile\.blockedSong'\)/);
  assert.match(ui, /playButton\.addEventListener\('click'[\s\S]*?if \(roomSongPlaying\) return;\s*syncVocalGain\(\);\s*void localFileMix\.play\(\);/,
    'a click that slips past the disabled button still cannot start it');
});

test('the room song holds the local file by YouTube\'s numeric state, as the room reports it', () => {
  // youtube-sync.js forwards room-song-status as received: state is a number.
  assert.equal(roomSongHoldsLocalFile({ state: 1 }), true, 'playing');
  assert.equal(roomSongHoldsLocalFile({ state: 3 }), true, 'buffering while playing');
  for (const state of [5, 2, 0, -1, null, undefined]) {
    assert.equal(roomSongHoldsLocalFile({ state }), false, `state ${state}`);
  }
  assert.equal(roomSongHoldsLocalFile(null), false);
  assert.equal(roomSongHoldsLocalFile({ state: 'playing' }), false, 'no word form exists');
  const handler = ui.slice(ui.indexOf("window.addEventListener('relay:playback-view'"));
  assert.match(handler, /const next = roomSongHoldsLocalFile\(event\.detail\?\.room\);/);
});

test('a file chosen after the room song started (picker left open) is refused with the reason', () => {
  const change = ui.slice(ui.indexOf("fileInput.addEventListener('change'"), ui.indexOf("closeButton.addEventListener"));
  assert.match(change, /if \(roomSongPlaying\) \{\s*showDuetNotice\('localFile\.blockedSong'\);\s*return;\s*\}\s*transientNote = null;\s*localFileMix\.open\(file\);/);
});

test('every room playing view pauses the local file, including a play still pending', () => {
  const handler = ui.slice(ui.indexOf("window.addEventListener('relay:playback-view'"));
  assert.match(handler, /if \(next && localFileMix\.active\) localFileMix\.pause\(\);/);
  assert.doesNotMatch(handler, /if \(next && !roomSongPlaying && localFileMix\.playing\) \{\s*localFileMix\.pause\(\)/,
    'not only on the transition into playing');
});

test('the note always ends with what the singer can do now', () => {
  assert.match(ui, /const nextStep = !ready \? t\('localFile\.needsMic'\) : heldByRoom \? t\('localFile\.blockedSong'\) : '';/);
  assert.match(ui, /note\.textContent = \[transientNote && t\(transientNote\), nextStep\]\.filter\(Boolean\)\.join\(' '\);/);
  assert.doesNotMatch(ui, /transientNote = t\(/, 'the note keeps a key, so a language switch re-translates it');
  const micState = ui.slice(ui.indexOf("window.addEventListener('relay-microphone-local-state'"));
  assert.match(micState, /if \(!micActive\) transientNote = null;/, 'a released Mic drops the last session note');
});
