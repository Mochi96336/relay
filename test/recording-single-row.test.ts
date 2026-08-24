import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../public/recording-ui.css', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/recording-ui.js', import.meta.url), 'utf8');

test('recording never reserves a second explanatory row', () => {
  assert.match(css, /grid-template-rows:\s*minmax\(44px, auto\)/);
  assert.doesNotMatch(css, /grid-template-rows:\s*44px\s+44px/);
  assert.doesNotMatch(css, /#recording-status[\s\S]{0,240}?grid-row:\s*2/);
});

test('blocked and pending recording copy use the status node in the Record slot', () => {
  assert.match(css, /data-recording-slot="status"[\s\S]*?#recording-status/);
  assert.doesNotMatch(css, /data-recording-slot="button-status"/);
  assert.match(ui, /presentSlot\('status', t\('recording\.starting'\)/);
  assert.match(ui, /presentSlot\('status', blockedCopy\(detail\.startBlockedReason\)/);
  assert.doesNotMatch(ui, /startButton\.textContent = copy/);
});

test('retryable failures remain actionable without adding another row', () => {
  assert.match(css, /data-recording-slot="status-action"[\s\S]*?> \.take-actions[\s\S]*?grid-column:\s*2 !important/);
  assert.match(css, /data-recording-slot="status-action"[\s\S]*?> \.recent-take[\s\S]*?display:\s*none !important/);
  assert.match(ui, /detail\.canStart === true \? 'status-action' : 'status'/);
});

test('active timer and completion states also stay in the same lifecycle slot', () => {
  assert.match(ui, /strip\.dataset\.recordingSlot = 'recording'/);
  assert.match(ui, /presentSlot\('status', t\('recording\.ready'\)/);
  assert.match(css, /data-take-state="recording"[\s\S]*?#recording-status[\s\S]*?grid-row:\s*1/);
  assert.match(css, /data-take-state="finalizing"[\s\S]*?#recording-status[\s\S]*?grid-row:\s*1/);
});
