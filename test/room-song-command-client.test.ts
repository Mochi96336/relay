import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('visible YouTube controls emit room intent and server apply performs media mutations', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const loadStart = source.indexOf('function loadVideo()');
  const loadEnd = source.indexOf("window.addEventListener('relay:room-song-command-sent'", loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart, 'load command boundary is missing');
  const loadSection = source.slice(loadStart, loadEnd);
  assert.match(loadSection, /requestRoomSongCommand\(\{ action: 'load'/);
  assert.doesNotMatch(loadSection, /cueVideoById|playVideo\s*\(/, 'user load must not mutate playback before server acceptance');

  const applyStart = source.indexOf('async function applyRoomSongCommand');
  const applyEnd = source.indexOf('async function restoreAuthoritativeRoom', applyStart);
  assert.ok(applyStart >= 0 && applyEnd > applyStart, 'server apply helper is missing');
  const applySection = source.slice(applyStart, applyEnd);
  assert.match(applySection, /cueVideoById/);
  assert.match(applySection, /playVideo\s*\(/);
  assert.match(applySection, /pauseVideo\s*\(/);
  assert.match(applySection, /seekTo\s*\(/);
  assert.match(applySection, /setPlaybackRate\s*\(/);
});

test('youtube sync owns command ids and expected revision instead of trusting page state', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(sync, /function randomRoomCommandId/);
  assert.match(sync, /type:\s*'room-song-command'/);
  assert.match(sync, /commandId/);
  assert.match(sync, /expectedRevision:\s*roomCommandRevision/);
  assert.match(sync, /type:\s*'room-song-command-status-request'/);
  assert.match(sync, /relay:room-song-command-apply/);
  assert.match(sync, /relay:room-song-command-rejected/);
});

test('room status observation alone never starts playback', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
  const branchStart = sync.indexOf("if (message.type === 'room-song-status')");
  const branchEnd = sync.indexOf("if (message.type === 'room-song-command-status')", branchStart);
  assert.ok(branchStart >= 0 && branchEnd > branchStart, 'room status branch is missing');
  const branch = sync.slice(branchStart, branchEnd);
  assert.match(branch, /latestRoomSongStatus = message/);
  assert.doesNotMatch(branch, /room-song-command-apply|playVideo|dispatchRoomCommand/, 'joining/observing room state must not apply or autoplay it');
});
