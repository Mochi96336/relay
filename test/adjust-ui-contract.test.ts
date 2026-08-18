import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/source.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/adjust.css', import.meta.url), 'utf8');
const ia = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const iaCss = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');

test('local Listen belongs to Live while Adjust owns shared mix and Timing', () => {
  const liveActions = html.indexOf('class="live-actions"');
  const localListen = html.indexOf('class="local-listen local-sound-control"');
  const adjust = html.indexOf('class="adjust-panel"');
  const roomMix = html.indexOf('class="adjust-group room-mix"');
  const timing = html.indexOf('class="adjust-group timing-adjust"');

  assert.ok(liveActions >= 0 && liveActions < localListen && localListen < adjust);
  assert.ok(adjust < roomMix && roomMix < timing);
  assert.equal(html.slice(adjust, timing).includes('id="listen-gain"'), false,
    'local playback volume must not remain inside Adjust');
  assert.equal(html.includes('>Room mix<'), true);
  assert.equal(html.includes('>Timing<'), true);
  assert.equal(html.includes('>Monitor<'), false);
});

test('Song is a fixed 100% reference while Adjust exposes only Voice', () => {
  const roomMix = html.indexOf('class="adjust-group room-mix"');
  const timing = html.indexOf('class="adjust-group timing-adjust"');
  const mix = html.slice(roomMix, timing);

  assert.equal(mix.includes('data-i18n="adjust.song"'), false,
    'Song must not remain a product-facing gain control');
  assert.match(
    mix,
    /id="song-level"[^>]*type="range"[^>]*min="100"[^>]*max="100"[^>]*value="100"[^>]*hidden/,
    'legacy songLevel compatibility input must be locked to the 100% reference',
  );
  assert.match(source, /Song reference/);
  assert.match(
    source,
    /id="source-volume"[^>]*type="range"[^>]*min="100"[^>]*max="100"[^>]*value="100"[^>]*hidden/,
    'the machine-side player must also clamp the legacy songLevel contract to 100%',
  );
});

test('Voice exposes +40 dB manual headroom without raising the automatic recommendation ceiling', () => {
  assert.match(
    html,
    /id="mic-gain"[^>]*min="0"[^>]*max="40"[^>]*value="24"/,
    'phone Voice control must expose the +40 dB manual ceiling',
  );
  assert.match(
    source,
    /id="source-mic-gain"[^>]*min="0"[^>]*max="40"[^>]*value="24"/,
    'machine-side readout must represent the same Voice range',
  );
  assert.equal(app.includes('const MAX_MIC_GAIN_DB = 40;'), true);
  assert.equal(app.includes('const MAX_RECOMMENDED_MIC_GAIN_DB = 36;'), true);
  assert.equal(app.includes('const FIXED_SONG_LEVEL = 100;'), true);
  assert.equal(app.includes('(suggested / MAX_MIC_GAIN_DB) * 100'), true,
    'recommendation marker must be positioned against the full +40 dB rail');
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