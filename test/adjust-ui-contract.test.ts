import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/adjust.css', import.meta.url), 'utf8');
const ia = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const iaCss = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');

test('local Listen is promoted to Live before the audio owner binds', () => {
  assert.equal(html.includes('class="adjust-group local-listen"'), true,
    'the legacy template still supplies the existing control IDs during the IA migration');
  assert.equal(html.indexOf('/live-ia.js') < html.indexOf('/listen.js'), true,
    'IA must settle the final DOM before listen.js queries its controls');
  assert.match(ia, /localListen\.classList\.remove\('adjust-group'\)/);
  assert.match(ia, /localListen\.classList\.add\('local-sound-control'\)/);
  assert.match(ia, /liveActions\.prepend\(localListen\)/);
  assert.match(ia, /listenAction\?\.remove\(\)/);
  assert.equal(html.includes('>Room mix<'), true);
  assert.equal(html.includes('>Timing<'), true);
  assert.equal(html.includes('>Monitor<'), false);
});

test('measured Mic input lives in the performance task while gain stays in Adjust', () => {
  const performance = html.indexOf('class="performance-stage"');
  const meter = html.indexOf('id="mic-input-meter"');
  const adjust = html.indexOf('class="adjust-panel"');
  const gain = html.indexOf('id="mic-gain"');
  assert.ok(performance >= 0 && performance < meter && meter < adjust && adjust < gain);
  assert.equal(app.includes('latestLocalMicLevel?.peakDbfs'), true);
  assert.equal(app.includes("event.data?.type === 'input-level'"), true);
  assert.equal(app.includes('latestMixHealth?.recommendedMicGainDb'), true);
  assert.equal(app.includes('latestMixHealth?.micPeakDbfs'), false);
  assert.equal(app.includes('useMicGainSuggestion.addEventListener'), true);
});

test('Mic capture epochs cannot reuse a previous capture gain recommendation', () => {
  const resets = app.match(/latestMixHealth = null;/g) ?? [];
  assert.ok(resets.length >= 3, 'initial state, stop, and new capture must all clear mix-health authority');

  const captureReset = app.indexOf('captureGeneration += 1;');
  const nextHealthReset = app.indexOf('latestMixHealth = null;', captureReset);
  const nextLocalReset = app.indexOf('latestLocalMicLevel = null;', captureReset);
  const healthReporting = app.indexOf('startAudioUplinkHealthReporting();', captureReset);
  assert.ok(captureReset >= 0);
  assert.ok(nextHealthReset > captureReset && nextHealthReset < healthReporting);
  assert.ok(nextLocalReset > nextHealthReset && nextLocalReset < healthReporting);
});

/**
 * The slider curve is `(percent / 100) ** 1.5`, so 30% was 16% amplitude -
 * -15.7 dB before a listener heard anything, on every page load, because the
 * value is neither stored nor synced. The server mix is already limited, and
 * the curve reaches unity exactly at 100, so unity is the honest starting
 * point and the slider exists to come down from it.
 */
test('Listen defaults at unity and exposes mute rather than enable', () => {
  assert.match(html, /id="listen-toggle"[^>]*data-i18n="listen\.mute"[^>]*>Mute<\/button>/);
  assert.match(html, /id="listen-gain-value"[^>]*>100%<\/output>/);
  assert.match(html, /id="listen-gain"[^>]*value="100"/);
  assert.equal(listen.includes('let userMuted = false;'), true);
  assert.equal(listen.includes('let micForcedMuted = false;'), true);
});

test('Adjust and System are transient sheets rather than extra Live page levels', () => {
  assert.match(iaCss, /\.adjust-panel\[open\],[\s\S]*?\.system-panel\[open\][\s\S]*?position: fixed;/);
  assert.match(iaCss, /max-height: min\(82dvh, 760px\);/);
  assert.match(iaCss, /overflow-y: auto;/);
  assert.match(iaCss, /body:has\(\.adjust-panel\[open\]\),[\s\S]*?overflow: hidden;/);
  assert.equal(css.includes('body:has(.adjust-panel[open]) .live-actions'), false,
    'opening Adjust must not recompose the Live page underneath');
  assert.match(ia, /if \(event\.target === panel\) closePanel\(panel, restoreFocus\);/);
  assert.match(ia, /if \(event\.key !== 'Escape'\) return;/);

  assert.equal(css.includes('content: "Done";'), false,
    'open/closed labels must come from the locale runtime rather than CSS-generated English');
  assert.equal(i18n.includes('function applyAdjustSummary()'), true);
  assert.equal(i18n.includes("t(panel.open ? 'adjust.done' : 'adjust.summary')"), true);
});

test('gain controls remain thin rails with explicit recommendation action', () => {
  assert.equal(css.includes('.adjust-range::-webkit-slider-runnable-track'), true);
  assert.equal(css.includes('height: 2px;'), true);
  assert.equal(css.includes('.recommendation-marker'), true);
});

test('Calibration enablement follows ProductStatus action authority', () => {
  assert.equal(app.includes('let roomCanStartCalibration = null;'), true);
  assert.equal(
    app.includes('roomCanStartCalibration = event.detail?.actions?.canStartCalibration === true;'),
    true,
  );

  const updateStart = app.indexOf('function updateCalibrateButton() {');
  const updateEnd = app.indexOf('function wsUrl()', updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  const updateBlock = app.slice(updateStart, updateEnd);
  const disabledStart = updateBlock.indexOf('calibrateButton.disabled = ');
  const disabledEnd = updateBlock.indexOf(';', disabledStart);
  assert.ok(disabledStart >= 0 && disabledEnd > disabledStart);
  const disabled = updateBlock.slice(disabledStart, disabledEnd);
  assert.equal(disabled.includes('publisherActive'), true);
  assert.equal(disabled.includes('roomSongAvailable'), true);
  assert.equal(disabled.includes('roomCanStartCalibration'), true);
  assert.equal(disabled.includes('liveMixActive'), false);
  assert.equal(disabled.includes('collecting'), false);
  assert.equal(disabled.includes('probeActive'), false);
});