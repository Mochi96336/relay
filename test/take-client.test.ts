import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser Take controls no longer participate in the audio pipeline', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /type:\s*'take-status-request'/);
  assert.match(source, /type:\s*'start-take'/);
  assert.match(source, /type:\s*'stop-take'/);
  assert.match(source, /message\.type === 'take-status'/);
  assert.match(source, /window\.relayParticipantId/);

  assert.doesNotMatch(source, /MediaRecorder/);
  assert.doesNotMatch(source, /AudioContext|AudioWorkletNode|createMediaStreamDestination/);
  assert.doesNotMatch(source, /role:\s*'monitor'/);
  assert.doesNotMatch(source, /binaryType|ArrayBuffer|Int16Array/);
  assert.doesNotMatch(source, /playback-worklet/);
});

test('browser reconnects to TakeSession state instead of coupling recording lifetime to its socket', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /function scheduleReconnect/);
  assert.match(source, /next\.send\(JSON\.stringify\(\{ type: 'take-status-request' \}\)\)/);

  const closeStart = source.indexOf("next.addEventListener('close'");
  const buttonStart = source.indexOf("recordButton.addEventListener('click'", closeStart);
  assert.ok(closeStart >= 0 && buttonStart > closeStart);
  const closeSection = source.slice(closeStart, buttonStart);
  assert.match(closeSection, /scheduleReconnect\(\)/);
  assert.doesNotMatch(closeSection, /stop-take|mediaRecorder|stopRecording/);
});

test('ready Take artifacts review inline instead of navigating away from Live', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(source, /function artifactUrl/);
  assert.match(source, /url\.searchParams\.set\('key', key\)/);
  assert.match(source, /recordingPlayer\.src = href/);
  assert.match(source, /lastTakeToggle\.addEventListener\('click'/);
  assert.match(source, /lastTakeReview\.hidden = !reviewOpen/);
  assert.match(source, /recordingDownload\.href = href/);
  assert.match(source, /recordingDownload\.download = `relay-take-/);
  assert.doesNotMatch(source, /window\.open|location\.href\s*=|lastTakeToggle\.href/);

  // Review is progressive disclosure inside Live; the artifact link is download-only.
  assert.match(html, /id="last-take" class="last-take" hidden/);
  assert.match(html, /id="last-take-toggle"[^>]*type="button"[^>]*aria-expanded="false"/);
  assert.match(html, /id="last-take-review"[^>]*hidden/);
  assert.match(html, /id="recording-player" controls preload="metadata"/);
  assert.match(html, /id="download-recording"[^>]*download[^>]*data-i18n="take\.download"[^>]*>Download WAV<\/a>/);
  assert.doesNotMatch(html, /id="download-recording"[^>]*target=/);
});

test('Take review consumes explicit local Mic lifecycle instead of a shared role global', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /let localMicActive = false/);
  assert.match(source, /relay-microphone-local-state/);
  assert.match(source, /localMicActive = event\.detail\?\.active === true/);
  assert.match(source, /function phoneOwnsMic\(\) \{\s*return localMicActive;\s*\}/);
  assert.doesNotMatch(source, /relayActiveRole/);
});
