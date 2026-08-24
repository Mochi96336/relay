import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const presentation = readFileSync(new URL('../public/room-sound-presentation.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/room-sound-ui.css', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const liveCopy = readFileSync(new URL('../public/live-i18n.js', import.meta.url), 'utf8');

test('Listen publishes room-sound truth while Room sound owns only the product projection', () => {
  assert.match(listen, /relay-listen-state/);
  assert.doesNotMatch(listen, /document\.body\.dataset\.listen/);
  assert.doesNotMatch(listen, /listen-adjust-state|listen-note|listen-gain-value/);
  assert.match(ui, /relay-listen-state/);
  assert.match(ui, /roomSoundPresentation/);
  assert.match(ui, /roomSoundStableNote/);
  assert.match(ui, /roomSoundActionNote/);
  assert.match(ui, /document\.body\.dataset\.listen/);
  assert.doesNotMatch(ui, /MutationObserver/);
});

test('Room sound presentation emits semantic keys rather than inline bilingual copy', () => {
  assert.doesNotMatch(presentation, /function copy\(|isChinese|traditionalChinese/);
  assert.match(presentation, /roomSound\.recovering/);
  assert.match(presentation, /roomSound\.pausedForMic/);
  assert.match(presentation, /roomSound\.pausedForBacking/);
  assert.match(presentation, /roomSound\.pausedForRecording/);
  assert.match(ui, /relayI18n\?\.t/);
  assert.match(liveCopy, /'roomSound\.label': 'Room sound'/);
  assert.match(liveCopy, /'roomSound\.label': '房間聲音'/);
});

test('Room sound has one CSS geometry owner and no presenter geometry rewrite', () => {
  assert.match(html, /id="local-listen-label"[^>]*>Room sound<\/span>/);
  assert.doesNotMatch(ui, /installCompactSemanticAnchor/);
  assert.doesNotMatch(ui, /\.style\.(?:gridTemplateColumns|gridColumn|gridRow|display|whiteSpace)/);
  assert.match(layoutCss, /grid-template-columns:\s*44px minmax\(0, 1fr\) auto/);
  assert.match(layoutCss, /#local-listen-label,[\s\S]*?#listen-note \{[\s\S]*?position:\s*absolute;/);
  assert.match(layoutCss, /#listen-gain-value \{[\s\S]*?display:\s*block;[\s\S]*?width:\s*4ch;/);
  assert.doesNotMatch(layoutCss, /data-room-sound-value|data-room-sound-state/);
  assert.doesNotMatch(css, /#local-listen-label|#listen-gain-value|#listen-adjust-state|#listen-note/,
    'room-sound-ui.css may paint state but must not regain rail geometry ownership');
});

test('Take review is a forced Listen overlay rather than a user mute mutation', () => {
  assert.match(listen, /let takeReviewForcedMuted = false/);
  assert.match(listen, /relay-take-review-playback/);
  assert.match(listen, /setTakeReviewForcedMute\(event\.detail\?\.active === true\)/);
});

test('Room sound keeps phase-aware full state reasons off layout while preserving accessible feedback', () => {
  assert.doesNotMatch(presentation, /compactStatusKey|compactKey/,
    'removed visible compact status must not survive as a second semantic model');
  assert.doesNotMatch(ui, /compactKey/);
  assert.doesNotMatch(ui, /dataset\.listenNote|dataset\.roomSoundState|dataset\.roomSoundValue/);
  assert.match(ui, /const stableKey = presentation\.noteKey \|\| roomSoundStableNote\(detail\)/);
  assert.match(ui, /stateNote\.textContent = localized\(stableKey\)/);
  assert.match(ui, /actionNote\.textContent = localized\(transientKey\)/);
  assert.match(ui, /aria-describedby', 'listen-adjust-state'/);
  assert.match(html, /id="listen-note"[^>]*aria-live="polite"/);
});

test('Room sound installs one stable vector icon instead of rebuilding it on every state update', () => {
  assert.match(ui, /function installRoomSoundIcon\(\)/);
  assert.match(ui, /toggle\.querySelector\('\.room-sound-icon'\)/);
  assert.match(ui, /toggle\.insertAdjacentHTML\('afterbegin', roomSoundIconMarkup\(\)\)/);
  assert.doesNotMatch(ui, /renderState[\s\S]*?toggle\.innerHTML/);
  assert.match(css, /#listen-toggle\[data-icon="muted"\]/);
  assert.match(css, /#listen-toggle\[data-icon="retry"\]/);
});

test('interrupted Room sound describes recovery instead of the generic enable hint', async () => {
  const {
    roomSoundActionNote,
    roomSoundControlPresentation,
    roomSoundPresentation,
    roomSoundStableNote,
  } = await import(new URL('../public/room-sound-presentation.js', import.meta.url).href);
  const detail = { state: 'ready', phase: 'interrupted', muted: false, forcedReason: null };
  assert.equal(roomSoundControlPresentation(detail).iconState, 'audible');
  assert.equal(roomSoundStableNote(detail), 'roomSound.enableHint');
  assert.equal(roomSoundPresentation(detail).noteKey, 'roomSound.recovering');
  assert.equal(roomSoundActionNote(detail), 'roomSound.recovering');
  assert.notEqual(roomSoundPresentation(detail).noteKey, 'roomSound.enableHint');
});
