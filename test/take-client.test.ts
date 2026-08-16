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

test('ready Take artifacts are played and downloaded from the server with the shared key preserved', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');
  assert.match(source, /function artifactUrl/);
  assert.match(source, /url\.searchParams\.set\('key', key\)/);
  assert.match(source, /recordingPlayer\.src = href/);
  assert.match(source, /recordingDownload\.href = href/);
  assert.match(source, /recordingDownload\.download = take\.artifact\.fileName/);
});
