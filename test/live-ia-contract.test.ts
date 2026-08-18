import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');
const composition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const takeHistory = readFileSync(new URL('../public/take-history.js', import.meta.url), 'utf8');
const roomSound = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');

function between(start: string, end: string) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected ${start} before ${end}`);
  return html.slice(from, to);
}

test('People owns identity and presence while secondary tasks live in More', () => {
  const people = between('class="people-menu"', 'id="room-more"');
  const more = between('id="room-more"', '</header>');

  assert.equal(people.includes('id="identity-name"'), true);
  assert.equal(people.includes('id="participant-list"'), true);
  assert.equal(people.includes('data-relay-locale'), false);

  assert.equal(more.includes('data-relay-locale="zh-Hant"'), true);
  assert.equal(more.includes('id="calibrate-timing"'), true);
  assert.equal(more.includes('id="vocal-fine-tune"'), true);
  assert.equal(more.includes('id="open-system"'), true);
  assert.equal(more.includes('id="open-adjust"'), false);
});

test('Live keeps Song then performance state and contextual Mic gain', () => {
  const song = html.indexOf('class="song-stage"');
  const performance = html.indexOf('class="performance-stage"');
  const gain = html.indexOf('id="mic-live-control"');
  const take = html.indexOf('class="take-strip"');
  assert.ok(song >= 0 && song < performance && performance < gain && gain < take);
  assert.equal(html.includes('id="youtube-player"'), true);
  assert.equal(css.includes('.performance-stage > .section-label'), true);
  assert.equal(css.includes('body[data-self-mic="live"] .mic-live-control'), true);
  assert.equal(script.includes("micLiveLabel.textContent = 'Mic';"), true);
});

test('persistent Live footer exposes only this-phone Room sound', () => {
  const footer = between('<footer class="live-actions">', '</footer>');
  assert.equal(footer.includes('id="listen-toggle"'), true);
  assert.equal(footer.includes('id="listen-gain"'), true);
  assert.equal(footer.includes('id="system-panel"'), false);
  assert.equal(footer.includes('id="mic-gain"'), false);

  assert.equal(script.includes("'./room-sound-ui.js'"), true);
  assert.match(script, /import\(modulePath\)\.catch/);
  assert.match(roomSound, /'房間聲音'/);
  assert.match(roomSound, /'只影響這支裝置'/);
  assert.match(roomSound, /'Room sound'/);
  assert.match(composition, /#listen-toggle \{[\s\S]*?min-height: 44px;/);
  assert.match(composition, /\.local-sound-control \.adjust-row-heading strong \{[\s\S]*?clip-path: inset\(50%\);/);
});

test('Room sound presentation does not own Listen transport or mute authority', () => {
  for (const forbidden of ['WebSocket', 'AudioContext', 'userMuted', 'micForcedMuted', 'playbackForcedMuted']) {
    assert.equal(roomSound.includes(forbidden), false, `room-sound-ui.js must not own ${forbidden}`);
  }
});

test('generic Adjust product layer is gone while System remains directly reachable', () => {
  assert.equal(html.includes('class="adjust-panel"'), false);
  assert.equal(html.includes('id="open-adjust"'), false);
  assert.equal(css.includes('.adjust-panel[open]'), false);
  assert.equal(script.includes('adjustPanel'), false);

  assert.equal(html.includes('id="open-system"'), true);
  assert.equal(html.includes('id="close-system"'), true);
  assert.match(css, /\.system-panel:not\(\[open\]\)[\s\S]*?display: none;/);
  assert.match(css, /\.system-panel\[open\] \{[\s\S]*?position: fixed;/);
  assert.match(script, /openSystem\?\.addEventListener\('click', revealSystem\)/);
  assert.match(script, /window\.addEventListener\('relay-open-system', revealSystem\)/);
});

test('System navigation is installed before optional Live presenters can fail', () => {
  const systemBinding = script.indexOf("openSystem?.addEventListener('click', revealSystem)");
  const optionalPresenterBoundary = script.indexOf('for (const modulePath of [');
  assert.ok(systemBinding >= 0);
  assert.ok(optionalPresenterBoundary > systemBinding);
  assert.doesNotMatch(script, /^import\s/m);
  assert.match(script, /import\(modulePath\)\.catch/);
  for (const presenter of [
    './mic-presence.js',
    './room-sound-ui.js',
    './people-ui.js',
    './recording-ui.js',
  ]) {
    assert.equal(script.includes(`'${presenter}'`), true);
  }
});

test('primary Live presenter CSS is render-blocking instead of arriving after module startup', () => {
  for (const stylesheet of [
    '/people-ui.css',
    '/room-sound-ui.css',
    '/recording-ui.css',
    '/take-history.css',
  ]) {
    assert.equal(css.includes(`@import url('${stylesheet}');`), true,
      `${stylesheet} must be reachable through the head-loaded Live IA stylesheet`);
  }
});

test('Live IA alone arbitrates System and Take history visibility', () => {
  assert.match(script, /window\.addEventListener\('relay-open-take-history', revealTakeHistory\)/);
  assert.match(script, /function revealTakeHistory\(\)[\s\S]*?closeSystemPanel\(false\);[\s\S]*?closeHeaderMenus\(\);[\s\S]*?panel\.open = true;/);
  assert.match(script, /function revealSystem\(\)[\s\S]*?closeTakeHistoryPanel\(\);[\s\S]*?closeHeaderMenus\(\);[\s\S]*?systemPanel\.open = true;/);

  assert.match(takeHistory, /window\.dispatchEvent\(new Event\('relay-open-take-history'\)\)/);
  assert.doesNotMatch(takeHistory, /#system-panel|#room-more|\.adjust-panel/);
});

test('recalibration is a direct task but app retains command authority', () => {
  assert.match(script, /calibrateTiming\?\.addEventListener\('click'/);
  assert.doesNotMatch(script, /start-timing-calibration|WebSocket/);
  assert.match(app, /calibrateButton\.addEventListener\('click'/);
  assert.match(app, /type: 'start-timing-calibration'/);
});

test('Traditional Chinese remains recording-oriented while Mic stays a literal product term', () => {
  const chineseStart = i18n.indexOf("'zh-Hant': {");
  assert.ok(chineseStart >= 0);
  const chinese = i18n.slice(chineseStart);
  assert.equal(chinese.includes("'take.record': '開始錄音'"), true);
  assert.equal(chinese.includes("'take.lastReady': '上一段錄音'"), true);
  assert.equal(script.includes("removeAttribute('data-i18n')"), true);
  assert.equal(script.includes("micLiveLabel.textContent = 'Mic'"), true);
});

test('Live IA does not reconstruct room or audio authority', () => {
  for (const forbidden of [
    'product-status',
    'mix-health',
    'micPeakDbfs',
    '/readyz',
    '/statusz',
    'WebSocket',
    'getUserMedia',
  ]) {
    assert.equal(script.includes(forbidden), false, `live-ia.js must not own ${forbidden}`);
  }
});

test('header and performance controls retain real phone-sized touch targets', () => {
  assert.equal(css.includes('.people-menu > summary {\n  min-height: 44px;'), true);
  assert.equal(css.includes('.more-menu > summary {\n  min-width: 44px;\n  min-height: 44px;'), true);
  assert.equal(css.includes('.more-popover .locale-option {\n  min-width: 44px;\n  min-height: 44px;'), true);
  assert.match(css, /\.mic-live-control > summary \{[\s\S]*?min-height: 48px;/);
  assert.equal(css.includes('.panel-done {'), true);
});

test('P0 Live states have one visible presenter each', () => {
  assert.match(css, /#start-publisher::after \{[\s\S]*?content: none;/);
  assert.match(css, /\.performance-stage:has\(#mic-takeover:not\(\[hidden\]\)\) \.mic-actions \{[\s\S]*?display: none;/);
  assert.match(css, /\.youtube-readout:has\(#server-timeline-state\)[\s\S]*?display: none;/);
  assert.match(css, /body\[data-listen="muted"\] #listen-note,[\s\S]*?body\[data-listen="playback-muted"\] #listen-note \{[\s\S]*?display: none;/);
});
