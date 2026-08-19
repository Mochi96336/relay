import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../public/source.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/adjust.css', import.meta.url), 'utf8');
const ia = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const calibrationUi = readFileSync(new URL('../public/calibration-ui.js', import.meta.url), 'utf8');
const iaCss = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');

test('local room sound stays on Live while generic Adjust disappears', () => {
  const performance = html.indexOf('class="performance-stage"');
  const localListen = html.indexOf('class="local-listen local-sound-control"');
  assert.ok(performance >= 0 && performance < localListen);
  assert.equal(html.includes('class="adjust-panel"'), false);
  assert.equal(html.includes('id="open-adjust"'), false);
  assert.equal(html.includes('id="listen-gain"'), true);
  assert.equal(html.includes('id="listen-toggle"'), true);
});

test('Mic gain belongs to the live singing task and expands in place', () => {
  const performance = html.indexOf('class="performance-stage"');
  const gainControl = html.indexOf('id="mic-live-control"');
  const gain = html.indexOf('id="mic-gain"');
  const take = html.indexOf('class="take-strip"');
  const footer = html.indexOf('class="live-actions"');

  assert.ok(performance >= 0 && performance < gainControl && gainControl < gain && gain < take && take < footer);
  assert.match(html, /id="mic-live-control" class="mic-live-control"/);
  assert.match(iaCss, /body\[data-self-mic="live"\] \.mic-live-control[\s\S]*?display: block;/);
  assert.match(iaCss, /\.mic-live-control > summary \{[\s\S]*?min-height: 48px;/);
  assert.equal(ia.includes("micLiveLabel.textContent = 'Mic';"), true,
    'the performance control must use the same Mic term as take/release');
});

test('Song is a fixed 100% reference while Mic is the only live mix variable', () => {
  assert.match(
    html,
    /id="song-level"[^>]*type="range"[^>]*min="100"[^>]*max="100"[^>]*value="100"[^>]*disabled/,
  );
  assert.match(source, /Song reference/);
  assert.match(
    source,
    /id="source-volume"[^>]*type="range"[^>]*min="100"[^>]*max="100"[^>]*value="100"[^>]*hidden/,
  );
  assert.equal(app.includes('const FIXED_SONG_LEVEL = 100;'), true);
});

test('Mic exposes +40 dB manual headroom without raising automatic recommendation ceiling', () => {
  assert.match(html, /id="mic-gain"[^>]*min="0"[^>]*max="40"[^>]*value="24"/);
  assert.match(source, /id="source-mic-gain"[^>]*min="0"[^>]*max="40"[^>]*value="24"/);
  assert.equal(app.includes('const MAX_MIC_GAIN_DB = 40;'), true);
  assert.equal(app.includes('const MAX_RECOMMENDED_MIC_GAIN_DB = 36;'), true);
  assert.equal(app.includes('(suggested / MAX_MIC_GAIN_DB) * 100'), true);
  assert.equal(app.includes('useMicGainSuggestion.addEventListener'), true);
});

test('realignment is a direct More task while fine tune survives as advanced detail', () => {
  const more = html.indexOf('id="room-more"');
  const calibrate = html.indexOf('id="calibrate-timing"');
  const fineTune = html.indexOf('id="vocal-fine-tune"');
  const system = html.indexOf('id="open-system"');
  assert.ok(more >= 0 && more < calibrate && calibrate < fineTune && fineTune < system);
  assert.match(html, /class="more-timing"/);
  assert.match(ia, /calibrateTiming\?\.addEventListener\('click'/);
  assert.match(ia, /import '\.\/calibration-ui\.js'/);
  assert.equal(ia.includes('adjustPanel'), false);
});

test('Robot calibration UI follows ProductStatus mode instead of Song availability', () => {
  assert.match(calibrationUi, /event\.detail\?\.actions/);
  assert.match(calibrationUi, /startCalibrationMode/);
  assert.match(calibrationUi, /mode === 'boot-probe'/);
  assert.match(calibrationUi, /reason === 'sources-not-connected'/);
  assert.match(calibrationUi, /reason === 'sources-not-streaming'/);
  assert.match(calibrationUi, /reason === 'calibration-active'/);
  assert.match(calibrationUi, /'重新對齊'/);
  assert.match(calibrationUi, /'對齊中…'/);
  assert.match(calibrationUi, /'正在準備聲音路徑…'/);
  assert.match(calibrationUi, /new MutationObserver\(queueRender\)/);

  const presenterStart = calibrationUi.indexOf('function render() {');
  const presenterEnd = calibrationUi.indexOf('function queueRender()', presenterStart);
  assert.ok(presenterStart >= 0 && presenterEnd > presenterStart);
  const presenter = calibrationUi.slice(presenterStart, presenterEnd);
  assert.equal(presenter.includes('roomSongAvailable'), false,
    'Robot realignment presenter must not infer prerequisites from Song state');
});

test('app command path stays start-timing-calibration while presenter owns Robot semantics', () => {
  assert.match(app, /type: 'start-timing-calibration'/);
  assert.match(calibrationUi, /ProductStatus owns calibration prerequisites/);
  assert.doesNotMatch(ia, /product-status/);
});

test('Listen defaults at unity and exposes mute rather than enable', () => {
  assert.match(html, /id="listen-toggle"[^>]*data-i18n="listen\.mute"[^>]*>Mute<\/button>/);
  assert.match(html, /id="listen-gain-value"[^>]*>100%<\/output>/);
  assert.match(html, /id="listen-gain"[^>]*value="100"/);
  assert.equal(listen.includes('let userMuted = false;'), true);
  assert.equal(listen.includes('let micForcedMuted = false;'), true);
});

test('System remains the only transient product sheet', () => {
  assert.match(iaCss, /\.system-panel\[open\] \{[\s\S]*?position: fixed;/);
  assert.match(iaCss, /max-height: min\(82dvh, 760px\);/);
  assert.match(iaCss, /body:has\(\.system-panel\[open\]\)[\s\S]*?overflow: hidden;/);
  assert.equal(iaCss.includes('.adjust-panel[open]'), false);
  assert.match(ia, /window\.addEventListener\('relay-open-system', revealSystem\)/);
});

test('gain controls remain thin rails with explicit recommendation action', () => {
  assert.equal(css.includes('.adjust-range::-webkit-slider-runnable-track'), true);
  assert.equal(css.includes('height: 2px;'), true);
  assert.equal(css.includes('.recommendation-marker'), true);
});
