import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ui = readFileSync(new URL('../public/recording-ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/recording-ui.css', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');

test('recording presentation consumes Take status without owning Take commands', () => {
  assert.match(liveIa, /import '\.\/recording-ui\.js';/);
  assert.match(ui, /relay-take-status/);
  assert.match(recorder, /type: 'start-take'/);
  assert.match(recorder, /type: 'stop-take'/);

  for (const forbidden of ['WebSocket', 'start-take', 'stop-take', 'take-status-request']) {
    assert.equal(ui.includes(forbidden), false, `recording-ui.js must not own ${forbidden}`);
  }
});

test('recording is one lifecycle action rather than persistent Start and Stop buttons', () => {
  assert.match(ui, /strip\.dataset\.takeState = lifecycle/);
  assert.match(css, /data-take-state="recording"[^\n]*#start-recording/);
  assert.match(css, /data-take-state="finalizing"[^\n]*#start-recording/);
  assert.match(css, /data-take-state="finalizing"[^\n]*#stop-recording/);
  assert.match(css, /data-take-state="recording"[^\n]*#stop-recording/);
  assert.match(css, /min-height: 44px/);
});

test('a newly completed Take gets a brief completion acknowledgement only after recording', () => {
  assert.match(ui, /previousLifecycle === 'recording' \|\| previousLifecycle === 'finalizing'/);
  assert.match(ui, /'✓ 錄好了'/);
  assert.match(ui, /1_400/);
  assert.doesNotMatch(ui, /setInterval/);
});
