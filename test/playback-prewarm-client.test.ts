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

  assert.match(continuation, /typeof window !== 'undefined'[\s\S]*typeof document !== 'undefined'/,
    'pure continuation helpers must not require browser globals in Node');
  assert.match(continuation, /import\('\.\/playback-prewarm-trigger\.js'\)/,
    'the browser runtime should still install the takeover prewarm trigger');
  assert.match(trigger, /typeof window !== 'undefined'/,
    'the trigger itself keeps a second browser-only guard');
  assert.match(trigger, /typeof document !== 'undefined'/);
  assert.match(trigger, /document\.addEventListener\('click',[\s\S]*true\);/);
  assert.match(trigger, /#start-publisher/);
  assert.match(trigger, /relay:playback-prewarm-intent/);
  assert.match(trigger, /#cancel-takeover/);
  assert.match(trigger, /relay:playback-prewarm-cancel/);
  assert.doesNotMatch(trigger, /playback-mic-intent|relay-request-microphone|release-mic/,
    'speculative warming must not cross the Mic or playback authority boundary');
});

test('speculative preparation requests real media while staying muted and local', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const startSection = topLevelFunctionSection(source, 'async function startPlaybackPrewarm()');
  assert.match(startSection, /reloadDesiredFromRoom\(latestPlaybackRoom\)/);
  assert.match(startSection, /ensurePlayer\(prewarm\.videoId\)/);
  assert.match(startSection, /playbackRole === 'holder' \|\| playbackRole === 'preparing'/,
    'an existing holder must never be muted by speculative Mic preparation');

  const primeSection = topLevelFunctionSection(source, 'function primeSpeculativePrewarm()');
  assert.match(primeSection, /player\.mute\(\)/,
    'the media request must be inaudible while takeover is unconfirmed');
  assert.match(primeSection, /player\.loadVideoById/,
    'cueVideoById alone does not request YouTube media and is not a real prewarm');
  assert.doesNotMatch(primeSection, /relay:youtube-telemetry|room-song-command/,
    'prewarm must stay local');

  const renderSection = topLevelFunctionSection(source, 'function renderSnapshot');
  assert.match(renderSection, /speculativePrewarm && !pendingHandoff\) return/,
    'speculative player movement must never become room telemetry or a room command');
});

test('cancel parks speculative playback and restores the user mute state', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const cancelSection = topLevelFunctionSection(source, 'function cancelPlaybackPrewarm()');
  const restoreSection = topLevelFunctionSection(source, 'function restorePrewarmMute');

  assert.match(cancelSection, /player\.pauseVideo/);
  assert.match(cancelSection, /restorePrewarmMute\(prewarm\)/);
  assert.match(restoreSection, /prewarm\.wasMuted === false/);
  assert.match(restoreSection, /player\.unMute/);
});

test('formal handoff consumes a matching warmed player and cold preparation still loads real media', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  const prepareSection = topLevelFunctionSection(source, 'async function prepareRoomSong');
  assert.match(prepareSection, /preparedPrewarm\.videoId === videoId/);
  assert.match(prepareSection, /reportedVideoId\(\) === videoId/);
  assert.match(prepareSection, /reusePreparedPlayer,/,
    'reuse belongs to this pending handoff rather than a one-off function argument');
  assert.match(prepareSection, /prewarmWasMuted:/);
  assert.match(prepareSection, /cuePendingHandoff\(\)/);

  const cueSection = topLevelFunctionSection(source, 'function cuePendingHandoff()');
  assert.match(cueSection, /pendingHandoff\.reusePreparedPlayer === true/);
  assert.match(cueSection, /player\.mute\(\)/,
    'formal preparation must stay inaudible before authority commits');
  assert.match(cueSection, /player\.seekTo/,
    'a warmed player may be corrected to the newer projected handoff time');
  assert.match(cueSection, /player\.loadVideoById/,
    'a cold or mismatched player must request actual media, not merely cue a thumbnail');
  assert.doesNotMatch(cueSection, /playVideo\s*\(/,
    'formal preparation still must not explicitly start audible playback before commit');
});

test('handoff ready requires a buffered active media state and polls through slow mobile startup', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const readySection = topLevelFunctionSection(source, 'function announceHandoffReady()');
  const scheduleSection = topLevelFunctionSection(source, 'function scheduleHandoffReadyChecks()');

  assert.match(readySection, /getVideoLoadedFraction/);
  assert.match(readySection, /\[1, 2, 3\]\.includes\(state\)/);
  assert.match(readySection, /bufferedFraction <= 0/);
  assert.doesNotMatch(readySection, /\[1, 2, 5\]\.includes\(state\)/,
    'CUED must not be treated as proof that media is buffered');
  assert.match(scheduleSection, /16_000/,
    'readiness polling should continue near the server preparation deadline');
});

test('commit restores the prior mute state, avoids an unconditional seek, and starts a bounded proof window', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const commitSection = topLevelFunctionSection(source, 'function commitRoomSong');

  assert.match(commitSection, /clearHandoffCommitTimer\(\)/);
  assert.match(commitSection, /const currentTime = Number\(player\.getCurrentTime\(\)\)/);
  assert.match(commitSection, /Math\.abs\(currentTime - pendingHandoff\.targetTime\) > 0\.75/);
  assert.match(commitSection, /player\.seekTo/);
  assert.match(commitSection, /pendingHandoff\.prewarmWasMuted === false/);
  assert.match(commitSection, /player\.unMute/);
  assert.match(commitSection, /player\.playVideo/);
  assert.match(commitSection, /HANDOFF_COMMIT_TIMEOUT_MS/);
  assert.match(commitSection, /rollbackCommittedHandoff\('commit-timeout', \{ reprepare: true \}\)/);
});

test('commit timeout parks and re-mutes the target before asking the server for a fresh prepare phase', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const rollbackSection = topLevelFunctionSection(source, 'function rollbackCommittedHandoff');

  assert.match(rollbackSection, /pendingHandoff\.phase = 'preparing'/);
  assert.match(rollbackSection, /player\.pauseVideo/);
  assert.match(rollbackSection, /player\.mute/);
  assert.match(rollbackSection, /relay:song-handoff-failed/);
  assert.match(rollbackSection, /cuePendingHandoff\(\)/,
    'a timeout may retry only after it first reports the failed commit');
});
