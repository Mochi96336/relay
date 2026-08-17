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

test('handoff readiness and completion require the video actually reported by YouTube', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const reportSection = topLevelFunctionSection(source, 'function reportedVideoId()');
  assert.match(reportSection, /getVideoData/);
  assert.doesNotMatch(reportSection, /loadedVideoId/, 'reported video proof must never fall back to local intent');

  const readySection = topLevelFunctionSection(source, 'function announceHandoffReady()');
  assert.match(readySection, /reportedVideoId\(\) !== pendingHandoff\.videoId/);

  const commitSection = topLevelFunctionSection(source, 'function commitRoomSong');
  assert.match(commitSection, /reportedVideoId\(\) !== pendingHandoff\.videoId/);

  const renderSection = topLevelFunctionSection(source, 'function renderSnapshot');
  assert.match(renderSection, /pendingHandoff\?\.phase === 'committing'/);
  assert.match(renderSection, /reportedVideoId\(\) !== pendingHandoff\.videoId/);
});

test('same-page reconnect cannot rewind an already committed handoff', async () => {
  const sync = await readFile(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

  assert.match(sync, /let activeHandoffId = null/);
  assert.match(sync, /let activeHandoffPhase = 'idle'/);
  assert.match(
    sync,
    /activeHandoffId === handoffId && activeHandoffPhase === 'committing'\) return/,
    'a replayed prepare for the same committed handoff must be ignored',
  );
  assert.match(
    sync,
    /activeHandoffPhase = 'committing';[\s\S]*relay:song-handoff-commit/,
    'commit must advance the adapter phase before dispatching to the player',
  );
  assert.match(
    sync,
    /activeHandoffId === handoffId\) activeHandoffPhase = 'preparing'/,
    'a real playback failure must re-open preparation so reconnect recovery remains possible',
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