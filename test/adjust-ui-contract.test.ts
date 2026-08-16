import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/adjust.css', import.meta.url), 'utf8');

test('Adjust separates shared room mix from this-phone Listen and Timing', () => {
  assert.equal(html.includes('>Room mix<'), true);
  assert.equal(html.includes('>This phone<'), true);
  assert.equal(html.includes('>Listen volume<'), true);
  assert.equal(html.includes('>Timing<'), true);
  assert.equal(html.includes('>Monitor<'), false);

  const localStart = html.indexOf('class="adjust-group local-listen"');
  const timingStart = html.indexOf('class="adjust-group timing-adjust"');
  const listenGain = html.indexOf('id="listen-gain"');
  assert.ok(localStart >= 0 && localStart < listenGain && listenGain < timingStart);
  assert.equal(html.slice(localStart, timingStart).includes('disabled'), false,
    'Listen volume stays locally adjustable even while Listen is off');
});

test('Voice Adjust distinguishes live input evidence from the gain setting and suggestion', () => {
  for (const id of [
    'mic-input-meter',
    'mic-input-value',
    'mic-gain-recommendation-marker',
    'use-mic-gain-suggestion',
  ]) assert.equal(html.includes(`id="${id}"`), true);
  assert.equal(app.includes('micPeakDbfs'), true);
  assert.equal(app.includes('recommendedMicGainDb'), true);
  assert.equal(app.includes('useMicGainSuggestion.addEventListener'), true);
  assert.equal(app.includes('Use +${suggested} dB'), true);

  const useSuggestion = app.indexOf("useMicGainSuggestion.addEventListener('click'");
  const calibrate = app.indexOf("calibrateButton.addEventListener('click'");
  assert.ok(useSuggestion >= 0 && calibrate > useSuggestion);
  const suggestionHandler = app.slice(useSuggestion, calibrate);
  assert.equal(suggestionHandler.includes('sendMixSettings();'), true,
    'applying the recommendation reuses the existing room mix command path');
  assert.equal(suggestionHandler.includes("type: '"), false,
    'recommendation UI must not invent a second gain command protocol');
});

test('Listen owns only local playback state and preserves volume while off', () => {
  assert.equal(listen.includes('document.body.dataset.listen = state'), true);
  assert.equal(listen.includes('Playing Relay mix on this phone.'), true);
  assert.equal(listen.includes('Volume is kept for next time.'), true);
});

test('Adjust uses one flat layer and thin rails instead of a card wall', () => {
  assert.equal(html.includes('href="/adjust.css"'), true);
  assert.equal(css.includes('border-radius: 0;'), true);
  assert.equal(css.includes('.voice-input-meter'), true);
  assert.equal(css.includes('height: 2px;'), true);
  assert.equal(css.includes('.adjust-range::-webkit-slider-runnable-track'), true);
});

test('opening Adjust morphs the performance area instead of overlaying the YouTube player', () => {
  assert.equal(css.includes('body:has(.adjust-panel[open]) .performance-stage'), true);
  assert.equal(css.includes('body:has(.adjust-panel[open]) .take-strip'), true);
  assert.equal(css.includes('.adjust-panel[open]'), true);
  assert.equal(css.includes('position: static;'), true);
  assert.equal(css.includes('content: "Done";'), true);
  assert.equal(css.includes('body:has(.adjust-panel[open]) .song-stage'), false,
    'the media field must remain in normal flow and unobscured while Adjust is open');
});
