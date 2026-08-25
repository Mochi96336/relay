import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');
const roomCss = readFileSync(new URL('../public/room-sound-ui.css', import.meta.url), 'utf8');
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

test('Room sound is one fixed 44px rail whose geometry lives only in the P0 layout', () => {
  assert.match(layoutCss, /\.local-sound-control \{[\s\S]*?height:\s*44px;[\s\S]*?min-height:\s*44px;[\s\S]*?grid-template-columns:\s*44px minmax\(0, 1fr\) auto/);
  assert.match(layoutCss, /#listen-gain \{[\s\S]*?height:\s*44px/);
  assert.match(layoutCss, /#listen-gain::\-webkit-slider-runnable-track \{[\s\S]*?height:\s*2px/);
  assert.match(layoutCss, /#listen-gain-value \{[\s\S]*?display:\s*block;[\s\S]*?width:\s*5ch/);
  assert.match(layoutCss, /#local-listen-label,[\s\S]*?#listen-note \{[\s\S]*?position:\s*absolute/);
  assert.doesNotMatch(layoutCss, /data-room-sound-value|data-room-sound-state/);
  assert.doesNotMatch(roomCss, /#local-listen-label|#listen-gain-value|#listen-adjust-state|#listen-note/);
  assert.doesNotMatch(roomUi, /installCompactSemanticAnchor/);
  assert.doesNotMatch(roomUi, /\.style\.(?:gridTemplateColumns|gridColumn|gridRow|display|whiteSpace)/);
  assert.doesNotMatch(roomUi, /dataset\.roomSoundState|dataset\.roomSoundValue|dataset\.listenNote/);
});

test('Room sound projection preserves recovery semantics and local-only authority without visible state narration', () => {
  assert.match(roomUi, /roomSoundControlPresentation/,
    'the DOM adapter must delegate control naming and state semantics to the presenter');
  assert.doesNotMatch(roomUi, /function compactStatus|compactKey|state === '(?:mic-muted|playback-muted|review-muted|muted)'/,
    'the DOM adapter must not reconstruct Room sound product state');
  assert.doesNotMatch(roomPresentation, /compactStatusKey|compactKey/);
  assert.match(roomPresentation, /labelKey:\s*'roomSound\.label'/);
  assert.match(roomPresentation, /volumeAriaLabelKey:\s*'roomSound\.volumeAria'/);
  assert.match(roomPresentation, /toggleAriaLabelKey:[\s\S]*?'roomSound\.retry'[\s\S]*?'roomSound\.turnOnAria'[\s\S]*?'roomSound\.muteAria'/);
  assert.match(liveCopy, /'roomSound\.label': 'Room sound'/);
  assert.match(liveCopy, /'roomSound\.label': '房間聲音'/);
  assert.match(roomUi, /gain\.disabled = forced/);
  assert.match(roomUi, /function roomSoundIconMarkup\(\)/);
  assert.match(roomUi, /class="room-sound-icon"/);
  assert.match(roomUi, /stroke="currentColor"/);
  assert.match(roomUi, /toggle\.dataset\.icon = controlPresentation\.iconState/);
  assert.match(roomUi, /installRoomSoundIcon\(\)/);
  assert.doesNotMatch(roomUi, /renderState[\s\S]*?toggle\.innerHTML/);
  assert.doesNotMatch(roomUi, /🔊|🔇/);
  assert.doesNotMatch(roomUi, /dataset\.roomSoundState|dataset\.roomSoundValue|dataset\.listenNote/,
    'semantic state may exist as text data, but it must not select rail geometry');
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