import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function topLevelFunctionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const nextFunction = source.indexOf('\nfunction ', start + declaration.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

test('browser prepares real media silently and starts only after server commit', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const cueSection = topLevelFunctionSection(source, 'function cuePendingHandoff()');
  assert.match(cueSection, /player\.mute\(\)/,
    'formal preparation must stay inaudible');
  assert.match(cueSection, /loadVideoById/,
    'formal preparation must request real media instead of stopping at CUED');
  assert.doesNotMatch(cueSection, /playVideo\s*\(/,
    'preparation must not explicitly start audible room playback');

  const commitSection = topLevelFunctionSection(source, 'function commitRoomSong');
  assert.match(commitSection, /playVideo\s*\(/, 'playing room state starts only after the server commits');
  assert.match(commitSection, /seekTo\s*\(/, 'commit must refresh the projected room position before starting');
});

test('a replacement handoff retires delayed readiness and commit work from the previous plan', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');

  const readyClearIndex = prepareSection.indexOf('clearHandoffReadyTimers()');
  const commitClearIndex = prepareSection.indexOf('clearHandoffCommitTimer()');
  const installIndex = prepareSection.indexOf('pendingHandoff = {');
  assert.ok(readyClearIndex >= 0, 'a new handoff must retire old readiness timers');
  assert.ok(commitClearIndex >= 0, 'a new handoff must retire an old commit watchdog');
  assert.ok(
    installIndex > readyClearIndex && installIndex > commitClearIndex,
    'old delayed work must be retired before the new handoff identity is installed',
  );
});

test('handoff readiness requires the exact YouTube video and actual buffered media', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const reportSection = topLevelFunctionSection(source, 'function reportedVideoId()');
  assert.match(reportSection, /getVideoData/);
  assert.doesNotMatch(reportSection, /loadedVideoId/, 'reported video proof must never fall back to local intent');

  const readySection = topLevelFunctionSection(source, 'function announceHandoffReady()');
  assert.match(readySection, /reportedVideoId\(\) !== pendingHandoff\.videoId/);
  assert.match(readySection, /getVideoLoadedFraction/);
  assert.match(readySection, /\[1, 2, 3\]\.includes\(state\)/,
    'PLAYING, PAUSED or BUFFERING may prove a live media pipeline');
  assert.match(readySection, /bufferedFraction <= 0/,
    'zero buffered media must not cross the ready boundary');
  assert.doesNotMatch(readySection, /\[1, 2, 5\]\.includes\(state\)/,
    'CUED alone is not media readiness');

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
