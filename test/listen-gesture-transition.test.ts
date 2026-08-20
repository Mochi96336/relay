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

test('Listen gates first transport start on a running AudioContext while preserving recovery transport', async () => {
  const source = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

  assert.match(source, /function audioGraphReady\(\)[\s\S]*Boolean\(audioContext && playbackNode && gainNode\)/);
  assert.match(source, /function audioRendering\(\)[\s\S]*audioContext\.state === 'running'/);
  assert.match(source, /function monitorTransportWanted\(\)[\s\S]*audioGraphReady\(\)[\s\S]*audioEverRunning/,
    'transport intent requires a built graph that has rendered successfully at least once');
  assert.match(source, /async function connect\(\)[\s\S]*!monitorTransportWanted\(\)/,
    'the monitor socket must not start before first successful audio rendering');

  const start = source.indexOf("  function reconcile(phase = '') {");
  const end = source.indexOf('  function forceMicMute(', start);
  assert.ok(start >= 0 && end > start);
  const reconcileSection = source.slice(start, end);

  assert.match(reconcileSection, /if \(!audioGraphReady\(\)\) \{[\s\S]*armAudioUnlock\(\);[\s\S]*render\(phase \|\| 'first-interaction'\);[\s\S]*return;/,
    'a graph that has not been built yet must stay behind the user gesture gate');
  assert.match(reconcileSection, /if \(!audioRendering\(\)\) \{[\s\S]*startResume\(audioContext\);[\s\S]*armAudioUnlock\(\);[\s\S]*if \(audioEverRunning\) \{[\s\S]*audioInterruption\.begin\(\);[\s\S]*ensureTransport\('interrupted'\);[\s\S]*return;[\s\S]*render\('first-interaction'\);[\s\S]*return;/,
    'a later OS interruption preserves transport intent without declaring timeline staleness by itself');
  assert.doesNotMatch(reconcileSection, /liveEdgeRecoveryRequired\s*=\s*true/,
    'resume trouble alone must not be equivalent to a stale realtime timeline');

  assert.match(
    source,
    /function finishAudioInterruptionEvidence\(\) \{[\s\S]*const recovery = audioInterruption\.finish\(\);[\s\S]*if \(recovery\.requiresLiveEdge\) liveEdgeRecoveryRequired = true;[\s\S]*return recovery\.requiresLiveEdge;/,
    'the interruption helper turns completed evidence into live-edge recovery state',
  );

  const stateChangeStart = source.indexOf("context.addEventListener('statechange'");
  const stateChangeEnd = source.indexOf("      // Consume the user's first interaction", stateChangeStart);
  assert.ok(stateChangeStart >= 0 && stateChangeEnd > stateChangeStart);
  const stateChangeSection = source.slice(stateChangeStart, stateChangeEnd);
  const finishEvidenceAt = stateChangeSection.indexOf('finishAudioInterruptionEvidence()');
  const markRunningAt = stateChangeSection.indexOf('audioEverRunning = true');
  assert.ok(
    finishEvidenceAt >= 0 && markRunningAt > finishEvidenceAt,
    'AudioContext state changes finish interruption evidence before marking the graph running again',
  );
  assert.ok(
    stateChangeSection.indexOf('stalledResumeGestures = 0') > markRunningAt
      && stateChangeSection.indexOf('disarmAudioUnlock()') > markRunningAt
      && stateChangeSection.indexOf('reconcile(') > markRunningAt,
    'running-state bookkeeping and reconciliation happen after interruption evidence is finalized',
  );
});
