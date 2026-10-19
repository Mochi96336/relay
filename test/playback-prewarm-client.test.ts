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
