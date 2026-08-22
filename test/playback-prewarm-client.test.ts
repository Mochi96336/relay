import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

function topLevelFunctionSection(source: string, declaration: string) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is missing`);
  const nextFunction = source.indexOf('\nfunction ', start + declaration.length);
  return source.slice(start, nextFunction >= 0 ? nextFunction : source.length);
}

test('the first Mic click installs a local playback prewarm trigger deterministically', async () => {
  const trigger = await readFile(new URL('../public/playback-prewarm-trigger.js', import.meta.url), 'utf8');
  const continuation = await readFile(new URL('../public/playback-continuation.js', import.meta.url), 'utf8');
  const youtube = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');

  assert.doesNotMatch(continuation, /playback-prewarm-trigger/,
    'pure continuation helpers must not hide browser side effects behind a dynamic import');
  assert.match(youtube, /^import '\.\/playback-prewarm-trigger\.js';/,
    'the visible YouTube runtime must install the capture listener before its module body runs');
  assert.match(trigger, /typeof window !== 'undefined'/,
    'the trigger itself keeps a browser-only guard');
  assert.match(trigger, /typeof document !== 'undefined'/);
  assert.match(trigger, /document\.addEventListener\('click',[\s\S]*true\);/);
  assert.match(trigger, /#start-publisher/);
  assert.match(trigger, /relay:playback-prewarm-intent/);
  assert.doesNotMatch(trigger, /#cancel-takeover/,
    'capture phase may start the first prewarm but must not preempt Presence cancel semantics');
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
  assert.match(startSection, /speculativePrewarm\?\.videoId === desired\.videoId/,
    'a duplicate Mic tap must refresh the existing attempt instead of replacing its mute provenance');
  assert.match(startSection, /speculativePrewarm\.targetTime =/);

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

test('abandoned takeover paths cancel speculative playback and restore mute provenance', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const presence = await readFile(new URL('../public/presence.js', import.meta.url), 'utf8');
  const trigger = await readFile(new URL('../public/playback-prewarm-trigger.js', import.meta.url), 'utf8');
  const cancelSection = topLevelFunctionSection(source, 'function cancelPlaybackPrewarm()');
  const restoreSection = topLevelFunctionSection(source, 'function restorePrewarmMute');

  assert.match(cancelSection, /player\.pauseVideo/);
  assert.match(cancelSection, /restorePrewarmMute\(prewarm\)/);
  assert.match(restoreSection, /prewarm\.wasMuted === false/);
  assert.match(restoreSection, /player\.unMute/);
  assert.match(presence, /hideTakeover\(\{ cancelPrewarm: true \}\)/,
    'owner changes/server restart must cancel a confirmation-time prewarm even without a Cancel click');
  assert.match(
    presence,
    /cancelTakeoverButton\.addEventListener\('click',[\s\S]*if \(!micActionState\(\)\.takeoverCancelActionable\) return;[\s\S]*hideTakeover\(\{ cancelPrewarm: true \}\)/,
    'Presence must prove shared takeover authority before a Cancel click can retire prewarm',
  );
  assert.doesNotMatch(trigger, /#cancel-takeover/,
    'capture-phase prewarm must not cancel before Presence applies startAfterTakeover policy');
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

test('handoff ready requires the desired renderable state, not BUFFERING or CUED', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const readySection = topLevelFunctionSection(source, 'function announceHandoffReady()');
  const scheduleSection = topLevelFunctionSection(source, 'function scheduleHandoffReadyChecks()');

  assert.match(readySection, /getVideoLoadedFraction/);
  assert.match(readySection, /const desiredPlaying =/);
  assert.match(readySection, /desiredPlaying \? state !== 1 : state !== 2/,
    'a playing room requires PLAYING and a paused room requires PAUSED');
  assert.match(readySection, /bufferedFraction <= 0/);
  assert.doesNotMatch(readySection, /\[1, 2, 3\]\.includes\(state\)/,
    'BUFFERING must not cross the ready boundary');
  assert.match(scheduleSection, /16_000/,
    'readiness polling should continue near the server preparation deadline');
});

test('commit starts the target clock muted and only direct server completion restores audibility', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const commitSection = topLevelFunctionSection(source, 'function commitRoomSong');
  const completeSection = topLevelFunctionSection(source, 'function completeRoomSong');

  assert.match(source, /const HANDOFF_COMMIT_TIMEOUT_MS = 6_500/,
    'the local watchdog must trail the authoritative 5 s server deadline');
  assert.match(commitSection, /clearHandoffCommitTimer\(\)/);
  assert.match(commitSection, /const currentTime = Number\(player\.getCurrentTime\(\)\)/);
  assert.match(commitSection, /Math\.abs\(currentTime - pendingHandoff\.targetTime\) > 0\.75/);
  assert.match(commitSection, /player\.seekTo/);
  assert.match(commitSection, /player\.mute\(\)/,
    'the target must remain inaudible while its telemetry is only a commit candidate');
  assert.doesNotMatch(commitSection, /player\.unMute/,
    'commit acknowledgement is not yet audible-room authority');
  assert.match(commitSection, /player\.playVideo/);
  assert.match(commitSection, /rollbackCommittedHandoff\('commit-timeout'\)/);
  assert.doesNotMatch(commitSection, /reprepare:\s*true/,
    'the late client watchdog must not seek again using a stale commit target');

  assert.match(completeSection, /prewarmWasMuted = pendingHandoff\.prewarmWasMuted/);
  assert.match(completeSection, /prewarmWasMuted === false/);
  assert.match(completeSection, /player\.unMute/,
    'only the explicit server completion packet may restore an originally audible player');
});

test('timeline promotion alone cannot unmute the new holder before the old leader is released', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const viewSection = source.slice(source.indexOf("window.addEventListener('relay:playback-view'"));

  assert.doesNotMatch(
    viewSection,
    /completeRoomSong\(\{ handoffId: pendingHandoff\.handoffId \}\)/,
    'server broadcasts promoted timeline before sending release/complete, so status cannot be an audibility barrier',
  );
  assert.match(source, /window\.addEventListener\('relay:song-handoff-complete'[\s\S]*completeRoomSong\(event\.detail/,
    'audibility still follows the direct ordered completion packet');
});

test('local commit timeout parks and reports failure without starting a stale local reprepare', async () => {
  const source = await readFile(new URL('../public/youtube.js', import.meta.url), 'utf8');
  const rollbackSection = topLevelFunctionSection(source, 'function rollbackCommittedHandoff');

  assert.match(rollbackSection, /pendingHandoff\.phase = 'preparing'/);
  assert.match(rollbackSection, /player\.pauseVideo/);
  assert.match(rollbackSection, /player\.mute/);
  assert.match(rollbackSection, /relay:song-handoff-failed/);
  assert.doesNotMatch(rollbackSection, /cuePendingHandoff\(\)/,
    'the server owns retry/cancel timing; a late client timeout must not reuse stale targetTime');
});