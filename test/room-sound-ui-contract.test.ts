import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const presentation = readFileSync(new URL('../public/room-sound-presentation.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/room-sound-ui.css', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const liveCopy = readFileSync(new URL('../public/live-i18n.js', import.meta.url), 'utf8');

test('Listen publishes room-sound truth while Room sound owns the visible projection', () => {
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

test('compact Room sound rail keeps a visible semantic label', () => {
  assert.match(html, /id="local-listen-label"[^>]*>Room sound<\/span>/);
  assert.match(ui, /title\.style\.display = 'block'/);
  assert.match(ui, /root\.style\.gridTemplateColumns = '44px auto minmax\(0, 1fr\) auto'/);
  assert.match(ui, /title\.style\.gridColumn = '2'/);
  assert.match(ui, /gain\.style\.gridColumn = '3'/);
});

test('Take review is a forced Listen overlay rather than a user mute mutation', () => {
  assert.match(listen, /let takeReviewForcedMuted = false/);
  assert.match(listen, /relay-take-review-playback/);
  assert.match(listen, /setTakeReviewForcedMute\(event\.detail\?\.active === true\)/);
});

test('Room sound keeps stable reasons separate from aria-live action feedback', () => {
  assert.match(css, /#listen-adjust-state \{[\s\S]*?display: none;/);
  assert.match(ui, /stateNote\.textContent = localized\(stableKey\)/);
  assert.match(ui, /actionNote\.textContent = localized\(transientKey\)/);
  assert.match(html, /id="listen-note"[^>]*aria-live="polite"/);
});

test('interrupted Room sound remains recovery semantics', async () => {
  const {
    roomSoundActionNote,
    roomSoundControlPresentation,
    roomSoundPresentation,
  } = await import(new URL('../public/room-sound-presentation.js', import.meta.url).href);
  const detail = { state: 'ready', phase: 'interrupted', muted: false, forcedReason: null };
  assert.equal(roomSoundControlPresentation(detail).compactKey, 'roomSound.compact.recovering');
  assert.equal(roomSoundPresentation(detail).noteKey, 'roomSound.recovering');
  assert.equal(roomSoundActionNote(detail), 'roomSound.recovering');
  assert.notEqual(roomSoundPresentation(detail).noteKey, 'roomSound.enableHint');
});
