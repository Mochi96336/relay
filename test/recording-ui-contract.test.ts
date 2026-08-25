import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/recording-ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/recording-ui.css', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
const product = readFileSync(new URL('../src/product-view-model.ts', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../src/take-start-policy.ts', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');

 test('required recording presentation consumes state without owning Take commands', () => {
  assert.match(html, /<script type="module" src="\/recording-ui\.js"><\/script>/);
  assert.equal(liveIa.includes("'./recording-ui.js'"), false);
  assert.match(ui, /relay-recording-state/);
  assert.match(ui, /relay-take-status/);
  assert.match(recorder, /type: 'start-take'/);
  assert.match(recorder, /type: 'stop-take'/);
  for (const forbidden of ['WebSocket', 'start-take', 'stop-take', 'take-status-request']) {
    assert.equal(ui.includes(forbidden), false, `recording-ui.js must not own ${forbidden}`);
  }
});

test('blocked Record stays visible and disabled while reason stays authoritative', () => {
  assert.match(ui, /strip\.hidden = false/);
  assert.match(ui, /startButton\.disabled = !canStart/);
  assert.doesNotMatch(ui, /startButton\.hidden = !canStart/);
  assert.match(ui, /blockedCopy\(detail\.startBlockedReason, detail\.startBlockingIssue\)/);
  assert.match(recorder, /status\.actions\?\.startTakeBlockedReason/);
  assert.match(recorder, /status\.actions\?\.startTakeBlockingIssue/);
  assert.match(product, /startTakeBlockedReason:/);
  assert.match(product, /startTakeBlockingIssue/);
  assert.doesNotMatch(
    recorder,
    /productCanStartTake \? null : 'mix-not-active'/,
    'recorder must not invent a readiness reason when ProductStatus omitted one',
  );
});

test('normal Take policy reasons all have explicit recording presentation', () => {
  for (const reason of [
    'mix-not-active',
    'timing-calibration-active',
    'mic-required',
    'mic-starting',
    'mic-reconnecting',
    'mic-audio-stalled',
    'room-blocked',
    'take-active',
  ]) {
    assert.match(policy, new RegExp(`'${reason}'`), `${reason} must be a policy reason`);
    assert.match(ui, new RegExp(`'${reason}'`), `${reason} must have recording presentation`);
  }
  assert.equal(policy.includes("'take-not-ready'"), false);
  assert.equal(ui.includes("'take-not-ready'"), false);
});

test('room-level blocks consume the server-selected ProductIssue instead of inspecting diagnostics', () => {
  assert.match(product, /startTake\.reason === 'room-blocked'/);
  assert.match(product, /issues\.find\(\(issue\) => issue\.severity === 'critical'\)/);
  assert.match(recorder, /startBlockedReason === 'room-blocked'/);
  assert.match(ui, /blockingIssueCopy\(issue\)/);
  assert.match(ui, /issue\?\.cause/);
  for (const forbidden of ['readiness', 'backingStreaming', 'robotSourceConnected', 'health ===']) {
    assert.equal(ui.includes(forbidden), false, `recording-ui.js must not infer ${forbidden}`);
  }
});

test('pending Start disables Record without inventing a server block reason', () => {
  assert.match(recorder, /serverAllowed: startAllowedByServer && !startCommandPending/);
  assert.match(recorder, /startPending: startCommandPending/);
  assert.match(recorder, /const startBlockedReason = startCommandPending\s*\? null/);
  assert.match(recorder, /startCommandPending = true;[\s\S]*?send\(\{ type: 'start-take' \}\)/);
  assert.match(ui, /const startPending = detail\.startPending === true/);
  assert.match(ui, /detail\.startPending === true[\s\S]*?t\('recording\.starting'\)/);
});

test('ready and blocked idle states keep the same Record slot', () => {
  assert.match(ui, /startButton\.hidden = recording \|\| finalizing/);
  assert.match(ui, /const canStart = detail\.canStart === true/);
  assert.match(css, /min-height: 44px/);
});

test('recording and finalizing keep the recording surface mounted', () => {
  assert.match(ui, /strip\.hidden = false/);
  assert.match(ui, /lifecycle === 'recording'/);
  assert.match(ui, /lifecycle === 'finalizing'/);
  assert.match(ui, /t\('recording\.finishing'\)/);
  assert.match(ui, /stopButton\.hidden = !recording/);
});

test('failed recording is product copy without Take identity', () => {
  assert.match(ui, /t\('recording\.failed'\)/);
  assert.doesNotMatch(ui, /shortTakeId/);
  assert.doesNotMatch(ui, /take\.takeId/);
  assert.doesNotMatch(ui, /Recording \$\{/);
  assert.doesNotMatch(ui, /錄音 \$\{/);
});

test('reconnect disables action without speculative readiness', () => {
  assert.match(recorder, /\? 'reconnecting'/);
  assert.match(ui, /recording\.blocked\.reconnecting/);
  assert.match(ui, /startButton\.disabled = !canStart/);
});

test('a newly completed recording gets a brief completion acknowledgement only after recording', () => {
  assert.match(ui, /previousLifecycle === 'recording' \|\| previousLifecycle === 'finalizing'/);
  assert.match(ui, /t\('recording\.ready'\)/);
  assert.match(ui, /1_400/);
  assert.doesNotMatch(ui, /setInterval/);
});

test('touched recording presenter uses the shared i18n boundary', () => {
  assert.match(ui, /relayI18n\?\.t/);
  assert.doesNotMatch(ui, /localCopy|function chinese/);
});
