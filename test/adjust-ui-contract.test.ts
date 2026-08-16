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
