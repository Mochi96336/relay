import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const listenSource = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('iOS AudioDestination recovery is only wired to foreground and post-Mic boundaries', () => {
  assert.match(listenSource, /import \{ IosAudioDestinationRecovery \} from '\.\/ios-audio-destination-recovery\.js'/);
  assert.match(listenSource, /const iosAudioDestinationRecovery = new IosAudioDestinationRecovery\(\)/);

  const occurrences = listenSource.match(/scheduleIosAudioDestinationRecovery\(/g) ?? [];
  assert.equal(
    occurrences.length,
    3,
    'the scheduler definition plus exactly foreground and post-Mic call sites are allowed',
  );
});

test('post-Mic destination restart begins only after AudioSession and Listen restore', () => {
  const start = listenSource.indexOf('function restoreAfterMicBoundary');
  const end = listenSource.indexOf('function setRoomMicForcedMute', start);
  assert.ok(start >= 0 && end > start);
  const boundary = listenSource.slice(start, end);

  const releaseSession = boundary.indexOf('claimMicrophoneAudio(false)');
  const restoreListen = boundary.indexOf('restoreAfterMic(phase)');
  const advanceBoundary = boundary.indexOf('micAudioBoundary += 1');
  const scheduleKick = boundary.indexOf("scheduleIosAudioDestinationRecovery(`post-mic:${micAudioBoundary}`)");
  assert.ok(
    releaseSession >= 0
      && restoreListen > releaseSession
      && advanceBoundary > restoreListen
      && scheduleKick > advanceBoundary,
    'post-Mic route policy must return to playback before the settled destination restart is scheduled',
  );
});

test('iOS destination readiness and current graph identity are proved separately', () => {
  const start = listenSource.indexOf('function scheduleIosAudioDestinationRecovery');
  const end = listenSource.indexOf('function recoverForegroundAudio', start);
  assert.ok(start >= 0 && end > start);
  const scheduler = listenSource.slice(start, end);

  assert.match(scheduler, /isCurrent: \(\) => audioContext === context/);
  assert.match(scheduler, /isEligible: \(\) => \([\s\S]*document\.visibilityState === 'visible'/);
  assert.match(scheduler, /!effectiveMuted\(\)/);
  assert.match(scheduler, /audioGraphReady\(\)/);
  assert.doesNotMatch(
    scheduler,
    /isEligible: \(\) => \([\s\S]*audioContext === context/,
    'context identity must remain a transaction fence after suspend, not disappear with mute eligibility',
  );
});

test('background lifecycle cancels pending destination work instead of restarting audio', () => {
  const start = listenSource.indexOf("document.addEventListener('visibilitychange'");
  const end = listenSource.indexOf("window.addEventListener('beforeunload'", start);
  assert.ok(start >= 0 && end > start);
  const lifecycle = listenSource.slice(start, end);

  assert.match(
    lifecycle,
    /document\.visibilityState !== 'visible'[\s\S]*foregroundAudioBoundary \+= 1;[\s\S]*iosAudioDestinationRecovery\.cancel\(\);[\s\S]*return;/,
  );
  assert.match(lifecycle, /window\.addEventListener\('pageshow', recoverForegroundAudio\)/);
  assert.match(
    lifecycle,
    /window\.addEventListener\('pagehide',[\s\S]*foregroundAudioBoundary \+= 1;[\s\S]*iosAudioDestinationRecovery\.cancel\(\)/,
  );
});
