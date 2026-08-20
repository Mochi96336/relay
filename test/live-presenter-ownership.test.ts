import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
const systemDetails = readFileSync(new URL('../public/system-details.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const roomSoundUi = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const micActions = readFileSync(new URL('../public/mic-actions.js', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
const recordingUi = readFileSync(new URL('../public/recording-ui.js', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');

test('playback transport publishes diagnostics without rendering Live debug DOM', () => {
  assert.match(youtubeSync, /relay:playback-diagnostics/);
  assert.doesNotMatch(youtubeSync, /server-timeline-state|server-timeline-values|server-timeline-note/);
  assert.doesNotMatch(youtubeSync, /Server timeline|Drift collecting|one-way≈/);
  assert.doesNotMatch(youtubeSync, /insertAdjacentElement/);

  assert.match(systemDetails, /relay:playback-diagnostics/);
  assert.match(systemDetails, /playbackClientLastRejection/);
  assert.match(systemDetails, /playback-client-last-rejection/);
});

test('listen owns audio state while room-sound-ui owns visible room-sound presentation', () => {
  assert.match(listen, /relay-listen-state/);
  assert.doesNotMatch(listen, /listen-note|listen-adjust-state|listen-gain-value/);
  assert.doesNotMatch(listen, /\.textContent\s*=|document\.body\.dataset\.listen|toggle\.disabled\s*=/);
  assert.doesNotMatch(listen, /dataset\.presenceLabel/,
    'Listen must consume Presence state directly instead of reading presenter DOM semantics');
  assert.match(listen, /relay-mic-action-state/);

  assert.match(roomSoundUi, /relay-listen-state/);
  assert.match(roomSoundUi, /toggle\.textContent\s*=/);
  assert.match(roomSoundUi, /stateNote\.textContent\s*=/);
  assert.match(roomSoundUi, /actionNote\.textContent\s*=/);
  assert.match(roomSoundUi, /document\.body\.dataset\.listen\s*=/);
  assert.doesNotMatch(roomSoundUi, /MutationObserver/);
});

test('presence owns Mic authority while required mic-actions owns the action surface', () => {
  assert.match(html, /<script type="module" src="\/mic-actions\.js"><\/script>/);
  assert.doesNotMatch(liveIa, /'\.\/mic-actions\.js'/);
  assert.match(presence, /relay-mic-action-state/);
  assert.doesNotMatch(presence, /takeoverCopy|takeoverPanel/);
  assert.doesNotMatch(presence, /publisherButton\.textContent\s*=/);
  assert.doesNotMatch(presence, /releaseButton\.hidden\s*=/);
  assert.doesNotMatch(presence, /confirmTakeoverButton\.disabled\s*=/);

  assert.match(micActions, /publisherButton\.textContent\s*=/);
  assert.match(micActions, /takeoverPanel\.hidden\s*=/);
  assert.match(micActions, /releaseButton\.hidden\s*=/);
  assert.match(micActions, /confirmTakeoverButton\.disabled\s*=/);
});

test('recorder owns commands while required recording-ui owns visible recording state', () => {
  assert.match(html, /<script type="module" src="\/recording-ui\.js"><\/script>/);
  assert.doesNotMatch(liveIa, /'\.\/recording-ui\.js'/);
  assert.match(recorder, /type: 'start-take'/);
  assert.match(recorder, /type: 'stop-take'/);
  assert.match(recorder, /relay-recording-state/);
  assert.doesNotMatch(recorder, /recordingStatus|\.textContent\s*=|\.disabled\s*=/);

  assert.match(recordingUi, /relay-recording-state/);
  assert.match(recordingUi, /startButton\.disabled\s*=/);
  assert.match(recordingUi, /stopButton\.disabled\s*=/);
  assert.match(recordingUi, /status\.textContent\s*=/);
});

test('sole action presenters are required siblings rather than swallowed optional imports', () => {
  for (const presenter of ['mic-actions', 'room-sound-ui', 'recording-ui']) {
    assert.match(html, new RegExp(`<script type="module" src="\\/${presenter}\\.js"><\\/script>`));
    assert.equal(liveIa.includes(`'./${presenter}.js'`), false);
  }
});
