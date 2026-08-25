import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');
const composition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const layout = readFileSync(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');
const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');
const liveI18n = readFileSync(new URL('../public/live-i18n.js', import.meta.url), 'utf8');
const takeHistory = readFileSync(new URL('../public/take-history.js', import.meta.url), 'utf8');
const roomSound = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const roomSoundPresentation = readFileSync(new URL('../public/room-sound-presentation.js', import.meta.url), 'utf8');
const people = readFileSync(new URL('../public/people-ui.js', import.meta.url), 'utf8');
const recordingUi = readFileSync(new URL('../public/recording-ui.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/presence.js', import.meta.url), 'utf8');
const micActions = readFileSync(new URL('../public/mic-actions.js', import.meta.url), 'utf8');

function between(start: string, end: string) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected ${start} before ${end}`);
  return html.slice(from, to);
}

test('People owns identity and presence while secondary tasks live in More', () => {
  const peopleRegion = between('class="people-menu"', 'id="room-more"');
  const more = between('id="room-more"', '</header>');

  assert.equal(peopleRegion.includes('id="identity-name"'), true);
  assert.equal(peopleRegion.includes('id="participant-list"'), true);
  assert.equal(peopleRegion.includes('data-relay-locale'), false);

  assert.equal(more.includes('data-relay-locale="zh-Hant"'), true);
  assert.equal(more.includes('id="calibrate-timing"'), true);
  assert.equal(more.includes('id="vocal-fine-tune"'), true);
  assert.equal(more.includes('id="open-system"'), true);
  assert.equal(more.includes('id="open-adjust"'), false);
});

test('Live keeps Song then one performance task with Record before Mic adjustment', () => {
  const song = html.indexOf('class="song-stage"');
  const performance = html.indexOf('class="performance-stage"');
  const gain = html.indexOf('id="mic-live-control"');
  const take = html.indexOf('class="take-strip"');
  assert.ok(song >= 0 && song < performance && gain > performance && take > performance);
  assert.equal(html.includes('id="youtube-player"'), true);
  assert.equal(css.includes('.performance-stage > .section-label'), true);
  assert.equal(css.includes('body[data-self-mic="live"] .mic-live-control'), true);
  assert.equal(script.includes("micLiveLabel.textContent = 'Mic';"), true);
  assert.match(composition, /\.performance-stage > \.take-strip \{ order: 5 !important; \}/);
  assert.match(composition, /\.performance-stage > \.mic-live-control \{ order: 6 !important; \}/);
  assert.doesNotMatch(script, /performanceStage\.insertBefore\(lastTake|append(?:Child)?\(lastTake/);
});

test('persistent Live footer exposes only this-phone Room sound', () => {
  const footer = between('<footer class="live-actions">', '</footer>');
  assert.equal(footer.includes('id="listen-toggle"'), true);
  assert.equal(footer.includes('id="listen-gain"'), true);
  assert.equal(footer.includes('id="system-panel"'), false);
  assert.equal(footer.includes('id="mic-gain"'), false);

  assert.match(html, /<script type="module" src="\/room-sound-ui\.js"><\/script>/);
  assert.equal(script.includes("'./room-sound-ui.js'"), false);
  assert.match(roomSound, /roomSoundControlPresentation/);
  assert.doesNotMatch(roomSound, /'房間聲音'|'只影響這支裝置'/,
    'the DOM adapter must not regain Room sound product-copy ownership');
  assert.match(roomSoundPresentation, /labelKey:\s*'roomSound\.label'/);
  assert.match(roomSoundPresentation, /scopeKey:\s*'roomSound\.scope'/);
  assert.doesNotMatch(roomSoundPresentation, /'房間聲音'|'只影響這支裝置'|'Room sound'/,
    'the semantic presenter owns keys, not locale branches');
  assert.match(liveI18n, /'roomSound\.label': 'Room sound'/);
  assert.match(liveI18n, /'roomSound\.label': '房間聲音'/);
  assert.match(liveI18n, /'roomSound\.scope': '只影響這支裝置'/);
  assert.doesNotMatch(composition, /\.local-sound-control|#listen-gain-value/,
    'formal composition must not own persistent Room sound rail geometry');
  assert.match(layout, /#listen-toggle \{[\s\S]*?width:\s*44px;[\s\S]*?min-height:\s*44px;/);
  assert.match(layout, /\.adjust-row-heading strong,[\s\S]*?#listen-adjust-state,[\s\S]*?#listen-note \{[\s\S]*?clip-path:\s*inset\(50%\);/);
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

test('System navigation is installed before degradable optional projections can fail', () => {
  const systemBinding = script.indexOf("openSystem?.addEventListener('click', revealSystem)");
  const optionalPresenterBoundary = script.indexOf('for (const modulePath of [');
  assert.ok(systemBinding >= 0);
  assert.ok(optionalPresenterBoundary > systemBinding);
  assert.doesNotMatch(script, /^import\s/m);
  assert.match(script, /import\(modulePath\)\.catch/);

  for (const presenter of ['./mic-presence.js', './people-ui.js']) {
    assert.equal(script.includes(`'${presenter}'`), true);
  }

  for (const presenter of ['mic-actions', 'room-sound-ui', 'recording-ui']) {
    assert.match(html, new RegExp(`<script type="module" src="\\/${presenter}\\.js"><\\/script>`));
    assert.equal(script.includes(`'./${presenter}.js'`), false,
      `${presenter} is a sole action presenter and must not be optional`);
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

  for (const [name, presenter] of [
    ['People', people],
    ['Room sound', roomSound],
    ['Recording', recordingUi],
    ['Take history', takeHistory],
  ] as const) {
    assert.doesNotMatch(presenter, /ensureStyles|document\.head\.append|createElement\('link'\)/,
      `${name} must not inject a second stylesheet after module startup`);
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

test('P0 Live states remove retired presenters instead of masking them later', () => {
  assert.doesNotMatch(style, /#start-publisher::after|Take over mic|content:\s*"Take mic"/);
  assert.doesNotMatch(youtubeSync, /server-timeline-state|server-timeline-values|server-timeline-note|insertAdjacentElement/);
  assert.match(youtubeSync, /relay:playback-diagnostics/);

  assert.match(roomSound, /relay-listen-state/);
  assert.doesNotMatch(roomSound, /MutationObserver/);

  assert.match(presence, /relay-mic-action-state/);
  assert.doesNotMatch(presence, /publisherButton\.textContent|takeoverPanel|takeoverCopy/);
  assert.match(micActions, /publisherButton\.hidden = takeoverOpen/);
  assert.match(micActions, /takeoverPanel\.hidden = !takeoverOpen/);
});
