import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function topLevelFunctionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const nextFunction = source.indexOf('\nfunction ', start + declaration.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

test('browser prepares playback without autoplay and starts only after server commit', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const cueSection = topLevelFunctionSection(source, 'function cuePendingHandoff()');
  assert.match(cueSection, /cueVideoById/);
  assert.doesNotMatch(cueSection, /playVideo\s*\(/, 'preparation must never autoplay the room song');

  const commitSection = topLevelFunctionSection(source, 'function commitRoomSong');
  assert.match(commitSection, /playVideo\s*\(/, 'playing room state starts only after the server commits');
  assert.match(commitSection, /seekTo\s*\(/, 'commit must refresh the projected room position before starting');
});

test('a replacement handoff retires delayed readiness checks from the previous plan', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');

  const clearIndex = prepareSection.indexOf('clearHandoffReadyTimers()');
  const installIndex = prepareSection.indexOf('pendingHandoff = {');
  assert.ok(clearIndex >= 0, 'a new handoff must retire old readiness timers');
  assert.ok(
    installIndex > clearIndex,
    'old readiness timers must be retired before the new handoff identity is installed',
  );
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