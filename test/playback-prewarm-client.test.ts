import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function topLevelFunctionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const nextFunction = source.indexOf('\nfunction ', start + declaration.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

test('the first Mic click starts only a local playback prewarm, before takeover confirmation', async () => {
  const trigger = await readFile(new URL('../public/playback-prewarm-trigger.js', import.meta.url), 'utf8');
  const continuation = await readFile(new URL('../public/playback-continuation.js', import.meta.url), 'utf8');

  assert.match(continuation, /import '\.\/playback-prewarm-trigger\.js'/);
  assert.match(trigger, /document\.addEventListener\('click',[\s\S]*true\);/);
  assert.match(trigger, /#start-publisher/);
  assert.match(trigger, /relay:playback-prewarm-intent/);
  assert.match(trigger, /#cancel-takeover/);
  assert.match(trigger, /relay:playback-prewarm-cancel/);
  assert.doesNotMatch(trigger, /playback-mic-intent|relay-request-microphone|release-mic/,
    'speculative warming must not cross the Mic or playback authority boundary');
});

test('speculative preparation cues the authoritative room song without autoplay or telemetry', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const startSection = topLevelFunctionSection(source, 'async function startPlaybackPrewarm()');
  assert.match(startSection, /reloadDesiredFromRoom\(latestPlaybackRoom\)/);
  assert.match(startSection, /ensurePlayer\(prewarm\.videoId\)/);

  const cueSection = topLevelFunctionSection(source, 'function cueSpeculativePrewarm()');
  assert.match(cueSection, /cueVideoById/);
  assert.doesNotMatch(cueSection, /playVideo\s*\(/, 'prewarm must never start room playback');
  assert.doesNotMatch(cueSection, /relay:youtube-telemetry|room-song-command/,
    'prewarm must stay local');

  const renderSection = topLevelFunctionSection(source, 'function renderSnapshot');
  assert.match(renderSection, /speculativePrewarm && !pendingHandoff\) return/,
    'speculative player movement must never become room telemetry or a room command');
});

test('formal handoff consumes a matching warmed player instead of rebuilding it', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');
  assert.match(prepareSection, /speculativePrewarm\.videoId === videoId/);
  assert.match(prepareSection, /reportedVideoId\(\) === videoId/);
  assert.match(prepareSection, /cuePendingHandoff\(\{ reusePreparedPlayer \}\)/);

  const cueSection = topLevelFunctionSection(source, 'function cuePendingHandoff');
  assert.match(cueSection, /reusePreparedPlayer/);
  assert.match(cueSection, /player\.seekTo/,
    'a warmed player may be corrected to the newer projected handoff time');
  assert.match(cueSection, /player\.cueVideoById/,
    'a cold or mismatched player still needs the normal cue path');
  assert.doesNotMatch(cueSection, /playVideo\s*\(/,
    'formal preparation still must not play before commit');
});

test('commit does not throw away a close warmed position with an unconditional seek', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const commitSection = topLevelFunctionSection(source, 'function commitRoomSong');

  assert.match(commitSection, /const currentTime = Number\(player\.getCurrentTime\(\)\)/);
  assert.match(commitSection, /Math\.abs\(currentTime - pendingHandoff\.targetTime\) > 0\.75/);
  assert.match(commitSection, /player\.seekTo/);
  assert.match(commitSection, /player\.playVideo/);
});
