import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const actionCss = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');
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

test('recording Stop becomes a text action once elapsed-time state exists', () => {
  const stopStart = actionCss.indexOf('#stop-recording:not(:disabled) {');
  const loadStart = actionCss.indexOf('#load-youtube {');
  assert.ok(stopStart >= 0 && loadStart > stopStart);
  const stopRules = actionCss.slice(stopStart, loadStart);
  assert.equal(stopRules.includes('border-radius: 0;'), true);
  assert.equal(stopRules.includes('background: transparent;'), true);
  assert.equal(html.includes('id="stop-recording"'), true);
});

test('participant presence chips are not reclassified as actions', () => {
  assert.equal(actionCss.includes('.participant-chip'), false);
});
