import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('first Listen gesture only primes audio and cannot manufacture Mic ownership', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

  assert.match(source, /async function activateFromGesture\(\)/);
  const start = source.indexOf('async function activateFromGesture()');
  const end = source.indexOf("toggle.addEventListener('click'", start);
  assert.ok(start >= 0 && end > start);
  const gestureSection = source.slice(start, end);

  assert.match(gestureSection, /await ensureAudioGraph\(\)/);
  assert.doesNotMatch(gestureSection, /micForcedMuted\s*=\s*true/);
  assert.doesNotMatch(gestureSection, /closest\('#start-publisher'\)|closest\('#confirm-takeover'\)/);

  assert.match(source, /publisherButton\.addEventListener\('click'[\s\S]*forceMicMute\(t\('listen\.micStarting'\)\)/,
    'the actual Mic click remains the early mute boundary');
  assert.match(source, /window\.addEventListener\('relay-microphone-start-failed'[\s\S]*restoreAfterMicBoundary/,
    'a real failed Mic start still has a terminal restore path');
});
