import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const actionCss = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');
const liveIaCss = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('formal Live loads a dedicated action-language layer', () => {
  assert.equal(stateCss.includes("@import url('/action-language.css');"), true);
});

test('Mic ownership and recording start are physical commit actions without pill geometry', () => {
  assert.equal(actionCss.includes('#start-publisher,\n#confirm-takeover'), true);
  assert.equal(actionCss.includes('#start-recording {'), true);
  assert.equal(actionCss.includes('border-radius: 9px;'), true);

  const micStart = actionCss.indexOf('#start-publisher,');
  const recordingStart = actionCss.indexOf('#start-recording {');
  assert.ok(micStart >= 0 && recordingStart > micStart);
  assert.equal(actionCss.slice(micStart, recordingStart).includes('999px'), false);
});

test('context and mode actions stay typographic instead of gaining hover capsules', () => {
  for (const selector of [
    '#change-youtube',
    '#release-mic',
    '#cancel-takeover',
    '#listen-toggle',
    '.recommendation-action',
    '#calibrate-timing',
  ]) assert.equal(actionCss.includes(selector), true);

  const textStart = actionCss.indexOf('.text-action {');
  const commitStart = actionCss.indexOf('/* Primary commitment');
  assert.ok(textStart >= 0 && commitStart > textStart);
  const textRules = actionCss.slice(textStart, commitStart);
  assert.equal(textRules.includes('border-radius: 0;'), true);
  assert.equal(textRules.includes('background: transparent;'), true);
  assert.equal(textRules.includes('background: rgba('), false);
});

test('typographic actions enlarge touch affordance without enlarging their visible shape', () => {
  const haloStart = actionCss.indexOf('#change-youtube::before,');
  const localStart = actionCss.indexOf('/* This-phone sound is the only persistent local control left on Live.');
  assert.ok(haloStart >= 0 && localStart > haloStart);
  const haloRules = actionCss.slice(haloStart, localStart);
  assert.equal(haloRules.includes('position: absolute;'), true);
  assert.equal(haloRules.includes('inset: -10px -4px;'), true);
  assert.equal(haloRules.includes('background:'), false,
    'transparent hit halos must never become visible button surfaces');
});

test('persistent local sound and secondary menu entries carry real 44px touch rows', () => {
  assert.equal(actionCss.includes('#listen-toggle {\n  min-height: 44px;'), true);
  assert.equal(liveIaCss.includes('.more-menu > summary {\n  min-width: 44px;\n  min-height: 44px;'), true);
  assert.equal(liveIaCss.includes('.more-action {'), true);
  assert.equal(liveIaCss.includes('min-height: 44px;'), true);
  assert.equal(actionCss.includes('#start-publisher,\n#confirm-takeover {\n  min-height: 44px;'), true);
  assert.equal(actionCss.includes('#load-youtube {\n  min-height: 44px;'), true);
});

test('Record stays visually quieter while its transparent halo reaches the touch target', () => {
  const recordStart = actionCss.indexOf('#start-recording {');
  const stopComment = actionCss.indexOf('/* Once recording is underway');
  assert.ok(recordStart >= 0 && stopComment > recordStart);
  const recordRules = actionCss.slice(recordStart, stopComment);
  assert.equal(recordRules.includes('min-height: 38px;'), true);
  assert.equal(recordRules.includes('#start-recording::after'), true);
  assert.equal(recordRules.includes('inset: -3px -6px;'), true);
});

test('recording Stop becomes a text action once elapsed-time state exists', () => {
  const stopStart = actionCss.indexOf('#stop-recording:not(:disabled) {');
  const loadStart = actionCss.indexOf('#load-youtube {');
  assert.ok(stopStart >= 0 && loadStart > stopStart);
  const stopRules = actionCss.slice(stopStart, loadStart);
  assert.equal(stopRules.includes('min-height: 44px;'), true);
  assert.equal(stopRules.includes('border-radius: 0;'), true);
  assert.equal(stopRules.includes('background: transparent;'), true);
  assert.equal(html.includes('id="stop-recording"'), true);
});

test('narrow phones compress width, not action semantics', () => {
  const narrowStart = actionCss.indexOf('@media (max-width: 360px)');
  assert.ok(narrowStart >= 0);
  const narrowRules = actionCss.slice(narrowStart);
  assert.equal(narrowRules.includes('#start-publisher { min-width: 116px; }'), true);
  assert.equal(narrowRules.includes('border-radius: 999px'), false);
});

test('participant presence chips are not reclassified as actions', () => {
  assert.equal(actionCss.includes('.participant-chip'), false);
});
