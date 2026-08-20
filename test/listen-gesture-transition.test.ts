import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Listen gesture gate stays retryable until browser audio is actually running', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

  assert.match(source, /async function activateFromGesture\(\)/);
  const start = source.indexOf('async function activateFromGesture()');
  const end = source.indexOf("toggle.addEventListener('click'", start);
  assert.ok(start >= 0 && end > start);
  const gestureSection = source.slice(start, end);

  assert.match(gestureSection, /await ensureAudioGraph\(\)/);
  assert.match(gestureSection, /armAudioUnlock\(\)/,
    'a failed graph setup keeps a later gesture available for retry');
  assert.doesNotMatch(gestureSection, /micForcedMuted\s*=\s*true/);
  assert.doesNotMatch(gestureSection, /closest\('#start-publisher'\)|closest\('#confirm-takeover'\)/);

  assert.match(source, /function armAudioUnlock\(\)[\s\S]*addEventListener\('pointerdown', activateFromGesture, \{ capture: true \}\)/);
  assert.match(source, /function disarmAudioUnlock\(\)[\s\S]*removeEventListener\('pointerdown', activateFromGesture, true\)/);
  assert.doesNotMatch(source, /addEventListener\('pointerdown', activateFromGesture, \{ capture: true, once: true \}\)/,
    'the first rejected resume must not consume the only unlock gesture');
  assert.match(source, /if \(!context \|\| !shouldRequestAudioResume\(context\.state\)\) return;/,
    'suspended and WebKit interrupted contexts share the same best-effort resume path');

  assert.match(source, /publisherButton\.addEventListener\('click'[\s\S]*forceMicMute\('mic-starting'\)/,
    'the actual Mic click remains the early mute boundary without owning product copy');
  assert.match(source, /window\.addEventListener\('relay-microphone-start-failed'[\s\S]*restoreAfterMicBoundary/,
    'a real failed Mic start still has a terminal restore path');
  assert.doesNotMatch(source, /t\('listen\./,
    'Listen gesture recovery must remain independent from Room sound wording');
});

test('Listen transport cannot run ahead of AudioContext readiness', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

  assert.match(source, /function audioReady\(\)[\s\S]*audioContext\.state === 'running'/);
  assert.match(source, /async function connect\(\)[\s\S]*!audioReady\(\)/,
    'the monitor socket must reject a non-running local audio engine');

  const start = source.indexOf("  function reconcile(phase = '') {");
  const end = source.indexOf('  function forceMicMute(', start);
  assert.ok(start >= 0 && end > start);
  const reconcileSection = source.slice(start, end);
  const readinessGate = reconcileSection.indexOf("audioContext.state !== 'running'");
  const enableTransport = reconcileSection.indexOf('transportEnabled = true');
  assert.ok(readinessGate >= 0 && enableTransport > readinessGate,
    'AudioContext readiness must be decided before transport is enabled');
  assert.match(reconcileSection, /audioContext\.state !== 'running'[\s\S]*closeTransport\(\);[\s\S]*armAudioUnlock\(\);[\s\S]*render\('first-interaction'\);[\s\S]*return;/,
    'a non-running context keeps transport closed, publishes its phase, and leaves the gesture gate armed');

  assert.match(source, /context\.addEventListener\('statechange'[\s\S]*context\.state === 'running'[\s\S]*disarmAudioUnlock\(\)[\s\S]*reconcile\(\)/,
    'AudioContext state changes, not resume requests, drive readiness reconciliation');
});
