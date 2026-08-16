import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser prepares playback without autoplay and starts only after server commit', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const cueStart = source.indexOf('function cuePendingHandoff()');
  const cueEnd = source.indexOf('function handleReady', cueStart);
  assert.ok(cueStart >= 0 && cueEnd > cueStart, 'prepared handoff helper is missing');
  const cueSection = source.slice(cueStart, cueEnd);
  assert.match(cueSection, /cueVideoById/);
  assert.doesNotMatch(cueSection, /playVideo\s*\(/, 'preparation must never autoplay the room song');

  const commitStart = source.indexOf('function commitRoomSong');
  const commitEnd = source.indexOf('function releaseRoomSong', commitStart);
  assert.ok(commitStart >= 0 && commitEnd > commitStart, 'handoff commit helper is missing');
  const commitSection = source.slice(commitStart, commitEnd);
  assert.match(commitSection, /playVideo\s*\(/, 'playing room state starts only after the server commits');
  assert.match(commitSection, /seekTo\s*\(/, 'commit must refresh the projected room position before starting');
});

test('playback transport is registered independently and Mic intent is explicit', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(sync, /type:\s*'playback-hello'/);
  assert.match(sync, /type:\s*'playback-mic-intent'/);
  assert.match(sync, /#start-publisher[^\n]*addEventListener\('click',\s*noteMicIntent\)/);
  assert.match(sync, /relay-request-microphone',\s*noteMicIntent/);
  assert.match(sync, /song-handoff-ready/);
  assert.match(sync, /song-handoff-failed/);
});
