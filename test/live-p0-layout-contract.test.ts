import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');
const roomUi = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const roomPresentation = readFileSync(new URL('../public/room-sound-presentation.js', import.meta.url), 'utf8');
const liveCopy = readFileSync(new URL('../public/live-i18n.js', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./fixtures/live-p0-layout.html', import.meta.url), 'utf8');

test('P0 layout repair is render-blocking and owns one shared Live inline track', () => {
  assert.match(stateCss, /@import url\('\/live-p0-layout\.css'\);/);
  assert.match(layoutCss, /--live-inline:\s*20px/);
  assert.match(layoutCss, /grid-template-columns:\s*\[live-left\]\s*minmax\(0, 1fr\)\s*\[live-right\]/);
  assert.match(layoutCss, /grid-auto-rows:\s*max-content/);
  assert.match(layoutCss, /align-content:\s*start/);
  assert.match(layoutCss, /\.live-shell\s*\{[\s\S]*?padding-inline:\s*var\(--live-inline\)/);
  assert.match(layoutCss, /\.live-shell > \.song-stage,[\s\S]*?\.live-shell > \.live-actions[\s\S]*?grid-column:\s*live-left \/ live-right/);
  assert.match(layoutCss, /\.youtube-player-shell,[\s\S]*?min-width:\s*0/);
});

test('Take History pins only the phone sheet and preserves desktop overlay centering', () => {
  const phoneMedia = layoutCss.match(/@media \(max-width:\s*759px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const desktopMedia = layoutCss.match(/@media \(min-width:\s*760px\) \{([\s\S]*)\n\}/)?.[1] ?? '';
  assert.match(phoneMedia, /\.take-history-panel\[open\] > \.take-history-sheet \{[\s\S]*?position:\s*fixed;[\s\S]*?inset-inline-start:\s*0;[\s\S]*?bottom:\s*0;/);
  assert.match(phoneMedia, /width:\s*100vw;[\s\S]*?max-width:\s*none;[\s\S]*?margin-inline:\s*0;/);
  assert.match(phoneMedia, /padding-left:\s*var\(--live-inline\);[\s\S]*?padding-right:\s*var\(--live-inline\)/);
  assert.match(desktopMedia, /width:\s*min\(720px, calc\(100vw - 48px\)\)/);
  assert.doesNotMatch(desktopMedia, /position:\s*fixed|bottom:\s*0|transform:\s*translateX/);
  assert.match(layoutCss, /\.take-history-item \{[\s\S]*?min-height:\s*64px/);
  assert.match(layoutCss, /\.take-history-item::after \{[\s\S]*?height:\s*2px/);
  assert.match(layoutCss, /#recording-player \{[\s\S]*?min-height:\s*44px/);
});

test('Room sound stays one 44px rail but presenter restores the semantic label column', () => {
  assert.match(layoutCss, /\.local-sound-control \{[\s\S]*?height:\s*44px;[\s\S]*?min-height:\s*44px/);
  assert.match(layoutCss, /#listen-gain \{[\s\S]*?height:\s*44px/);
  assert.match(layoutCss, /#listen-gain::\-webkit-slider-runnable-track \{[\s\S]*?height:\s*2px/);
  assert.match(roomUi, /root\.style\.gridTemplateColumns = '44px auto minmax\(0, 1fr\) auto'/);
  assert.match(roomUi, /title\.style\.display = 'block'/);
  assert.match(roomUi, /title\.style\.gridColumn = '2'/);
  assert.match(roomUi, /gain\.style\.gridColumn = '3'/);
  assert.match(roomUi, /gainValue\.style\.gridColumn = '4'/);
  assert.match(layoutCss, /data-room-sound-value="visible"[\s\S]*?#listen-gain-value/);
});

test('Room sound projection preserves recovery semantics, localized control names, local-only ownership, and product vector iconography', () => {
  assert.match(roomUi, /roomSoundControlPresentation/,
    'the DOM adapter must delegate compact labels and state wording to the presenter');
  assert.doesNotMatch(roomUi, /function compactStatus|state === '(?:mic-muted|playback-muted|review-muted|muted)'/,
    'the DOM adapter must not reconstruct Room sound product state');
  assert.match(roomPresentation, /labelKey:\s*'roomSound\.label'/);
  assert.match(roomPresentation, /volumeAriaLabelKey:\s*'roomSound\.volumeAria'/);
  assert.match(roomPresentation, /toggleAriaLabelKey:[\s\S]*?'roomSound\.turnOnAria'[\s\S]*?'roomSound\.muteAria'/);
  assert.match(liveCopy, /'roomSound\.label': 'Room sound'/);
  assert.match(liveCopy, /'roomSound\.label': '房間聲音'/);
  assert.match(roomUi, /gain\.disabled = forced/);
  assert.match(roomUi, /function roomSoundIcon\(muted\)/);
  assert.match(roomUi, /class="room-sound-icon"/);
  assert.match(roomUi, /stroke="currentColor"/);
  assert.match(roomUi, /toggle\.dataset\.icon = visuallyMuted \? 'muted' : 'audible'/);
  assert.match(roomUi, /toggle\.innerHTML = roomSoundIcon\(visuallyMuted\)/);
  assert.doesNotMatch(roomUi, /🔊|🔇/);
  assert.match(roomUi, /root\.dataset\.listenNote = stableKey \? 'visible' : 'quiet'/);
  assert.match(roomUi, /root\.dataset\.roomSoundState = controlPresentation\.compactKey \? 'visible' : 'quiet'/);
  for (const forbidden of ['new WebSocket', 'new AudioContext', 'createGain', 'monitorPacketVersion']) {
    assert.equal(roomUi.includes(forbidden), false, `Room sound presenter must not own ${forbidden}`);
  }
});

test('P0 visual fixture uses production presenters, production-shaped Live DOM, real Take media, and browser geometry', () => {
  for (const state of [
    'empty',
    'listener',
    'singer',
    'recording',
    'take-history-one',
    'take-history-many',
    'room-sound-normal',
    'room-sound-muted',
    'room-sound-forced',
    'room-sound-retry',
  ]) {
    assert.equal(fixture.includes(state), true, `missing P0 visual state: ${state}`);
  }
  assert.match(fixture, /class="song-heading-actions"/);
  assert.match(fixture, /class="song-observer-meta"/);
  assert.match(fixture, /id="release-mic" class="text-action"/);
  assert.match(fixture, /id="stop-recording" class="record-action recording"/);
  assert.match(fixture, /id="change-youtube" class="text-action"/);
  assert.match(fixture, /await import\('\/room-sound-ui\.js'\)/);
  assert.match(fixture, /await import\('\/take-history\.js'\)/);
  assert.match(fixture, /dispatchEvent\(new CustomEvent\('relay-take-status'/);
  assert.doesNotMatch(fixture, /<details class="take-history-panel"/);
  assert.match(fixture, /createSilentWavUrl/);
  assert.match(fixture, /recordingPlayer\.currentTime = 1/);
  assert.match(fixture, /take-many-groups/);
  assert.match(fixture, /take-many-artworks/);
  assert.match(fixture, /audio-duration/);
  assert.match(fixture, /audio-seek/);
  assert.match(fixture, /document\.documentElement\.scrollWidth/);
  assert.match(fixture, /shared-left-song-performance/);
  assert.match(fixture, /__geometry-\$\{result\}/);
  assert.match(fixture, /forced-gain-disabled/);
  assert.match(fixture, /retry-status/);
  assert.match(fixture, /gain-aria/);
});
