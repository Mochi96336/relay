import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const ui = await readFile(new URL('../public/local-file-ui.js', import.meta.url), 'utf8');

test('while the room song plays, the local file cannot start again and says why', () => {
  assert.match(ui, /const heldByRoom = roomSongPlaying && !playing;/);
  assert.match(ui, /playButton\.disabled = !playing && \(!ready \|\| heldByRoom\);/);
  assert.match(ui, /heldByRoom \? t\('localFile\.blockedSong'\)/);
  assert.match(ui, /playButton\.addEventListener\('click'[\s\S]*?if \(roomSongPlaying\) return;\s*syncVocalGain\(\);\s*void localFileMix\.play\(\);/,
    'a click that slips past the disabled button still cannot start it');
});

test('every room playing view pauses the local file, including a play still pending', () => {
  const handler = ui.slice(ui.indexOf("window.addEventListener('relay:playback-view'"));
  assert.match(handler, /if \(next && localFileMix\.active\) localFileMix\.pause\(\);/);
  assert.doesNotMatch(handler, /if \(next && !roomSongPlaying && localFileMix\.playing\) \{\s*localFileMix\.pause\(\)/,
    'not only on the transition into playing');
});
