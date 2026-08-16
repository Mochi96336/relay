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

  const suggestionBeforeHandler = app.slice(0, useSuggestion);
  assert.equal(suggestionBeforeHandler.includes('micGain.value = String(Math.max'), false,
    'incoming recommendation evidence must not move Voice gain before the user chooses Use');
});

test('Listen defaults audible at 30% and exposes mute rather than an enable action', () => {
  assert.match(html, /id="listen-toggle"[^>]*>Mute<\/button>/);
  assert.match(html, /id="listen-gain-value"[^>]*>30%<\/output>/);
  assert.match(html, /id="listen-gain"[^>]*value="30"/);
  assert.equal(listen.includes('let userMuted = false;'), true);
  assert.equal(listen.includes("toggle.textContent = micForcedMuted ? 'Muted for Mic' : userMuted ? 'Unmute' : 'Mute';"), true);
  assert.equal(listen.includes('Sound starts after your first interaction.'), true,
    'default-unmuted intent must acknowledge the mobile autoplay boundary');
});

test('Mic ownership overlays a temporary local mute and restores the prior Listen preference', () => {
  assert.equal(listen.includes('let micForcedMuted = false;'), true);
  assert.equal(listen.includes('return userMuted || micForcedMuted;'), true);
  assert.equal(listen.includes("window.addEventListener('relay-microphone-started'"), true);
  assert.equal(listen.includes("window.addEventListener('relay-microphone-ended'"), true);
  assert.equal(listen.includes("window.addEventListener('relay-microphone-start-failed'"), true);
  assert.equal(listen.includes("window.addEventListener('relay-request-microphone'"), true);
  assert.equal(listen.includes("publisherButton.addEventListener('click'"), true,
    'local Mic intent mutes before publisher registration finishes');
  assert.equal(listen.includes("publisherButton.dataset.presenceLabel !== 'takeover'"), true,
    'opening takeover confirmation must not mute Listen before the handoff is confirmed');
  assert.equal(listen.includes('Do not auto-resume afterward'), false);
  assert.equal(listen.includes("message.type === 'timing-calibration-status'"), false,
    'timing setup no longer owns the product-level Listen preference');
});

test('Listen keeps browser audio permission separate from the muted transport state', () => {
  assert.equal(listen.includes('async function ensureAudioGraph()'), true);
  assert.equal(listen.includes('function closeTransport()'), true);
  assert.equal(listen.includes('await context.resume();'), true);
  assert.equal(listen.includes("window.addEventListener('pointerdown', activateFromGesture"), true);
  assert.equal(listen.includes("window.addEventListener('keydown', activateFromGesture"), true);
  assert.equal(listen.includes('Playing Relay mix on this phone.'), true);
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
