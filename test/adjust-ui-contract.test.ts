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
const actionLanguage = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
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

test('realignment stays a direct More task while manual timing tweak is compatibility-only', () => {
  const more = html.indexOf('id="room-more"');
  const calibrate = html.indexOf('id="calibrate-timing"');
  const system = html.indexOf('id="open-system"');
  assert.ok(more >= 0 && more < calibrate && calibrate < system);
  assert.match(html, /class="more-timing"/,
    'legacy DOM may remain while app.js compatibility is retained');
  assert.match(actionLanguage, /\.more-timing \{\n  display: none !important;/,
    'manual timing tweak must not be a visible Live product control');
  assert.match(app, /type: 'set-vocal-fine-tune'/,
    'presentation cleanup must not accidentally delete the compatibility protocol');
  assert.match(ia, /calibrateTiming\?\.addEventListener\('click'/);
  assert.match(ia, /import\('\.\/calibration-ui\.js'\)/);
  assert.equal(ia.includes('adjustPanel'), false);
});

test('calibration presenter waits for authenticated command readiness', () => {
  const systemBinding = ia.indexOf("openSystem?.addEventListener('click', revealSystem)");
  const readyListener = ia.indexOf("window.addEventListener('relay-calibration-command-ready'");
  const calibrationLoader = ia.indexOf("import('./calibration-ui.js')");
  assert.ok(systemBinding >= 0);
  assert.ok(readyListener > systemBinding);
  assert.ok(calibrationLoader > systemBinding);
  assert.match(ia, /window\.relayCalibrationCommandReady === true/);
  assert.doesNotMatch(ia, /DOMContentLoaded[\s\S]*installCalibrationPresenter/,
    'DOM readiness is not proof that app.js has captured the command node');

  const commandBinding = app.lastIndexOf("calibrateButton.addEventListener('click'");
  const authoritySeed = app.lastIndexOf('publishPublisherCommandAuthority();');
  const readyFlag = app.lastIndexOf('window.relayCalibrationCommandReady = true;');
  const readyEvent = app.lastIndexOf("dispatchRelayEvent('relay-calibration-command-ready')");
  assert.ok(commandBinding >= 0 && commandBinding < authoritySeed);
  assert.ok(authoritySeed < readyFlag && readyFlag < readyEvent,
    'the visible presenter may install only after command listener + initial authority exist');
});

test('calibration command transport obeys fresh ProductStatus policy without a local Song gate', () => {
  assert.doesNotMatch(app, /roomSongAvailable|roomCanStartCalibration/,
    'app.js must not maintain a second local calibration-policy cache');
  assert.match(app, /function calibrationServerAllowed\(\)/);
  assert.match(app, /const authority = window\.relayProductAuthority/);
  assert.match(app, /authority\?\.authorityFresh === true/);
  assert.match(app, /authority\?\.lastKnownSnapshot\?\.actions\?\.canStartCalibration === true/);
  assert.match(app, /window\.addEventListener\('relay-product-authority', updateCalibrateButton\)/,
    'command transport must follow the same freshness transitions as ProductStatus presentation');

  const updateStart = app.indexOf('function updateCalibrateButton()');
  const updateEnd = app.indexOf('\nfunction wsUrl()', updateStart);
  const updateBody = app.slice(updateStart, updateEnd);
  assert.match(updateBody, /publisherCommandAuthority\(\s*calibrationServerAllowed\(\)/);
  assert.doesNotMatch(updateBody, /textContent|latestCalibration|liveMixActive|videoId|timeline|probeActive/,
    'compatibility command transport must not paint or rebuild room policy');

  const commandStart = app.lastIndexOf("calibrateButton.addEventListener('click'");
  const commandEnd = app.indexOf('\n\nupdateMixLabels()', commandStart);
  const commandBody = app.slice(commandStart, commandEnd);
  assert.match(commandBody, /publisherCommandAuthority\(calibrationServerAllowed\(\)\)\.actionable/);
  assert.match(commandBody, /type: 'start-timing-calibration'/);
  assert.doesNotMatch(commandBody, /song|videoId|timeline|startCalibrationMode/);
});

test('calibration visible presenter follows ProductStatus and has one painted owner', () => {
  assert.match(calibrationUi, /latestProductStatus = event\.detail \?\? null/);
  assert.match(calibrationUi, /latestAction = latestProductStatus\?\.actions/);
  assert.match(calibrationUi, /latestTiming = latestProductStatus\?\.timing/);
  assert.match(calibrationUi, /reason === 'calibration-active'/);
  assert.match(calibrationUi, /window\.relayI18n\?\.t/);
  assert.match(calibrationUi, /t\('timing\.realign'\)/);
  assert.match(calibrationUi, /t\('timing\.aligning'\)/);
  assert.match(calibrationUi, /t\('timing\.unavailable'\)/);
  assert.doesNotMatch(calibrationUi, /startCalibrationMode|mode === 'boot-probe'|sources-not-connected|sources-not-streaming/,
    'visible presenter must not reinterpret server implementation reasons as progress');
  assert.doesNotMatch(calibrationUi, /getLocale/,
    'visible calibration copy must not maintain a private locale switch');
  assert.doesNotMatch(calibrationUi, /'重新對齊'|'對齊中…'|'Realign'|'Aligning…'/,
    'visible copy belongs to shared i18n rather than a local bilingual table');
  assert.match(calibrationUi, /legacyFineTuneSurface\.hidden = true/);
  assert.match(calibrationUi, /takeVisibleOwnership/);
  assert.match(calibrationUi, /cloneNode/);
  assert.match(calibrationUi, /calibrate-timing-command/);
  assert.doesNotMatch(calibrationUi, /MutationObserver/,
    'visible product state must not be resolved by last-writer-wins DOM observation');
  assert.doesNotMatch(calibrationUi, /roomSongAvailable/,
    'calibration presenter must consume semantic policy instead of rebuilding Song prerequisites');
});

test('timing calibration copy is concise and contains no singing restriction', () => {
  assert.match(i18n, /'timing\.label': '時間對齊'/);
  assert.match(i18n, /'timing\.realign': '重新對齊'/);
  assert.match(i18n, /'timing\.aligning': '對齊中…'/);
  assert.match(i18n, /'timing\.unavailable': '目前無法重新對齊'/);
  assert.match(i18n, /'timing\.realign': 'Realign'/);
  assert.match(i18n, /'timing\.aligning': 'Aligning…'/);
  assert.doesNotMatch(i18n, /Don’t sing|Don't sing|先不要唱|不要出聲|停止唱歌/);
  assert.doesNotMatch(i18n, /provisional \{lag\}|已套用暫定值/);
});

test('locale changes rerender the one visible calibration presenter', () => {
  assert.match(calibrationUi, /window\.addEventListener\('relay-locale-changed', render\)/);
  assert.match(calibrationUi, /calibrateButton\.removeAttribute\?\.\('data-i18n'\)/);
  assert.match(calibrationUi, /button\.id = 'calibrate-timing-command'/);
  assert.match(calibrationUi, /button\.hidden = true/);
});

test('app remains authenticated command transport while ProductStatus owns visible result', () => {
  assert.match(app, /type: 'start-timing-calibration'/);
  assert.match(calibrationUi, /commandTarget\.dispatchEvent/);
  assert.match(calibrationUi, /next server ProductStatus determines the rendered result/);
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
