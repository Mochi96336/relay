import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('browser Take controls no longer participate in the audio pipeline', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /import '\.\/take-history\.js'/);
  assert.match(source, /type:\s*'take-status-request'/);
  assert.match(source, /type:\s*'start-take'/);
  assert.match(source, /type:\s*'stop-take'/);
  assert.match(source, /message\.type === 'take-status'/);
  assert.match(source, /sendParticipantAuthentication/);
  assert.match(source, /participant-auth\.js/);
  assert.doesNotMatch(source, /params\.set\('cap',/);

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

test('Take control connection recovers when the socket closes before opening', async () => {
  const source = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');

  assert.match(source, /const onClose = \(\) => settle\(reject, new Error\('Take WebSocket closed before opening\.'\)\)/,
    'pre-open close must settle the pending connection instead of hanging forever');
  assert.match(source, /next\.addEventListener\('close', onClose\)/,
    'the close listener must be installed before awaiting the opening handshake');
  assert.match(source, /catch \(error\) \{[\s\S]*if \(socket === next\) socket = null;[\s\S]*throw error;/,
    'a failed opening handshake must release the stranded socket so reconnect can create a replacement');
});

test('durable Take history keeps Live compact and reuses one review player in a secondary sheet', async () => {
  const recorder = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../public/take-history.js', import.meta.url), 'utf8');
  const historyCss = await readFile(new URL('../public/take-history.css', import.meta.url), 'utf8');
  const model = await readFile(new URL('../public/take-history-model.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(recorder, /new CustomEvent\('relay-take-status', \{ detail: status \}\)/);
  assert.match(history, /import \{ groupHistory, historyFromStatus \} from '\.\/take-history-model\.js'/);
  assert.match(model, /Array\.isArray\(status\?\.history\)/);
  assert.match(model, /export function groupHistory/);
  assert.match(model, /`song:\$\{videoId\}`/);
  assert.match(history, /i\.ytimg\.com\/vi/);
  assert.match(history, /localCopy\('Voice only', '純人聲'\)/);
  assert.match(history, /localCopy\('Recovered recordings', '舊錄音'\)/);
  assert.match(history, /panel\.id = 'take-history-panel'/,
    'full history belongs to a secondary sheet rather than the Live performance flow');
  assert.match(historyCss, /\.take-history-panel\[open\][\s\S]*?position: fixed;/);
  assert.match(history, /root\.classList\.add\('recent-take'\)/,
    'Live retains only a compact latest-Take continuation');
  assert.match(history, /recentButton\.textContent = localCopy\(/);
  assert.match(history, /recordingPlayer\.src = href/);
  assert.match(history, /recordingDownload\.href = href/);
  assert.match(history, /recordingDownload\.download = `relay-take-/);
  assert.match(history, /selectedTakeId = status\.take\.takeId/,
    'a newly finalized Take becomes the comparison target immediately');
  assert.match(history, /takeBusy = status\?\.lifecycle === 'recording' \|\| status\?\.lifecycle === 'finalizing'/);
  assert.match(history, /if \(!recordingPlayer\.paused\) recordingPlayer\.pause\(\)/,
    'history review must stop while a new Take is recording or finalizing');
  assert.doesNotMatch(history, /legacyToggle\?\.remove\(\)/,
    'the Live latest-Take entry remains the route into history');
  assert.doesNotMatch(history, /createElement\('audio'\)/,
    'history must reuse the one existing review player');
  assert.equal((html.match(/<audio\b/g) ?? []).length, 1,
    'Relay must expose exactly one Take review player');
  assert.match(html, /id="recording-player" controls preload="metadata"/);
  assert.match(html, /id="download-recording"[^>]*download[^>]*data-i18n="take\.download"[^>]*>Download WAV<\/a>/);
  assert.doesNotMatch(`${history}\n${model}`, /new WebSocket|start-take|stop-take|product-status/,
    'history review must not reconstruct Take or product authority');
  assert.doesNotMatch(history, /window\.open|location\.href\s*=/);
});

test('Take history keeps English Take language and Traditional Chinese recording language', async () => {
  const history = await readFile(new URL('../public/take-history.js', import.meta.url), 'utf8');

  assert.match(history, /localCopy\('Recordings', '錄音'\)/);
  assert.match(history, /localCopy\('Take history', '錄音紀錄'\)/);
  assert.match(history, /localCopy\('Selected Take playback', '所選錄音播放'\)/);
  assert.match(history, /localCopy\('Release mic before reviewing a Take\.', '請先放開 Mic，再播放錄音。'\)/);
  assert.match(history, /`Last take · \$\{formatDuration/);
  assert.match(history, /`上一段錄音 · \$\{formatDuration/);
});

test('Take review feedback guard belongs to history and composes local Mic with room ownership', async () => {
  const recorder = await readFile(new URL('../public/recorder.js', import.meta.url), 'utf8');
  const history = await readFile(new URL('../public/take-history.js', import.meta.url), 'utf8');

  assert.match(history, /let localMicActive = false/);
  assert.match(history, /let roomMicActive = false/);
  assert.match(history, /relay-microphone-local-state/);
  assert.match(history, /localMicActive = event\.detail\?\.active === true/);
  assert.match(history, /relay-session-status/);
  assert.match(history, /ownerId === participantId/);
  assert.match(history, /relay-request-session-status/);
  assert.match(history, /function phoneOwnsMic\(\) \{[\s\S]*return localMicActive \|\| roomMicActive;[\s\S]*\}/);
  assert.doesNotMatch(history, /relayActiveRole/);
  assert.doesNotMatch(recorder, /relay-session-status|relay-microphone-local-state/,
    'recorder lifecycle must no longer own review feedback state');
});

test('Take review playback isolates itself from live Room sound and stops with its sheet', async () => {
  const history = await readFile(new URL('../public/take-history.js', import.meta.url), 'utf8');
  const listen = await readFile(new URL('../public/listen.js', import.meta.url), 'utf8');

  assert.match(history, /new CustomEvent\('relay-take-review-playback'/);
  assert.match(history, /recordingPlayer\.addEventListener\('play'[\s\S]*dispatchReviewPlayback\(true\)/);
  assert.match(history, /recordingPlayer\.addEventListener\('pause', \(\) => dispatchReviewPlayback\(false\)\)/);
  assert.match(history, /panel\.addEventListener\('toggle'[\s\S]*!panel\.open[\s\S]*recordingPlayer\.pause\(\)/,
    'closing Take history, including when System replaces it, must stop review audio');
  assert.match(listen, /let takeReviewForcedMuted = false/);
  assert.match(listen, /effectiveMuted\(\)[\s\S]*takeReviewForcedMuted/);
  assert.match(listen, /relay-take-review-playback/);
  assert.match(listen, /setTakeReviewForcedMute\(event\.detail\?\.active === true\)/);
  assert.doesNotMatch(history, /listen-toggle|listen-gain|userMuted/,
    'Take history must request isolation without mutating the user\'s Room sound controls');
});
