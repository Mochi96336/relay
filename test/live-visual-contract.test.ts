import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const song = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');
const songSurface = readFileSync(new URL('../public/song-surface.js', import.meta.url), 'utf8');
const state = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8');
const model = readFileSync(new URL('../public/mic-presence-model.js', import.meta.url), 'utf8');
const capture = readFileSync(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const actions = readFileSync(new URL('../public/action-language.css', import.meta.url), 'utf8');

test('holder YouTube stays real, compact and above a usable embedded-player floor', () => {
  assert.match(composition, /\.youtube-player-shell \{[\s\S]*?width: 100%;[\s\S]*?min-height: 200px;[\s\S]*?aspect-ratio: 16 \/ 9;/);
  assert.match(composition, /\.youtube-player-shell iframe \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?min-height: 200px;/);
});

test('observer Song is a compact room snapshot because it does not host YouTube transport', () => {
  assert.match(song, /\.song-observer \{[\s\S]*?min-height: 92px;/);
  assert.match(song, /grid-template-columns: 92px minmax\(0, 1fr\);/);
  assert.match(song, /data-playback-role="observer"[\s\S]*?\.youtube-player-shell/);
});

test('playback holder compresses song identity into the heading row above the real YouTube controls', () => {
  assert.match(song, /\.song-heading-title \{[\s\S]*?flex: 1;[\s\S]*?text-overflow: ellipsis;[\s\S]*?white-space: nowrap;[\s\S]*?font-size: 12px;/);
  assert.match(songSurface, /const metadataMode = observerMode \|\| holderWithSong;/);
  assert.match(songSurface, /headingTitle\.hidden = !holderWithSong;/);
  assert.match(songSurface, /observer\.hidden = !observerMode;/);
  assert.doesNotMatch(song, /data-playback-role="holder"\] \.song-observer/);
});

test('holder Change song is visible as a real phone touch target instead of tiny utility text', () => {
  assert.match(song, /#change-youtube \{[\s\S]*?min-height: 44px;[\s\S]*?padding: 0 12px;/);
  assert.match(song, /\.youtube-form\[hidden\] \{ display: none; \}/);
  assert.match(song, /data-playback-role="holder"\]\[data-song-editing="false"\] \.youtube-form[\s\S]*?display: none;/);
});

test('Room Mic is one centered full-bleed envelope backed by one 20-sample measured history', () => {
  assert.match(composition, /\.voice-input-evidence \{[\s\S]*?width: 100vw;[\s\S]*?margin: 10px calc\(50% - 50vw\) 2px;/);
  assert.match(composition, /\.voice-input-meter \{[\s\S]*?width: 100%;[\s\S]*?max-width: none;[\s\S]*?height: 56px;/);
  assert.match(composition, /-webkit-mask-image: linear-gradient\(to right, transparent 0%, #000 6%, #000 94%, transparent 100%\);/);
  assert.match(composition, /mask-image: linear-gradient\(to right, transparent 0%, #000 6%, #000 94%, transparent 100%\);/);
  assert.doesNotMatch(composition, /\.voice-input-meter\s*\{[\s\S]{0,180}?width:\s*min\(100%,\s*(?:320|310)px\)/);
  assert.match(composition, /\.voice-presence-baseline/);
  assert.match(composition, /\.voice-presence-wave/);
  assert.match(model, /MIC_PRESENCE_SLICE_COUNT = 20/);
  assert.match(model, /MIC_PRESENCE_BAND_COUNT = 5/);
  assert.match(model, /export function centerOriginX/);
  assert.match(presence, /CENTER_Y = VIEWBOX_HEIGHT \/ 2/);
  assert.match(presence, /presenceSliceGeometry/);
  assert.match(presence, /envelopePath\(\)/);
  assert.match(presence, /smoothPath\(upper\)/);
  assert.match(liveStatus, /MIC_PRESENCE_TELEMETRY_INTERVAL_MS = 80/);
  assert.match(presence, /event\.detail\?\.spectrumBands/);
  assert.doesNotMatch(composition, /grid-template-columns: repeat\(10/);
  assert.doesNotMatch(presence, /voice-presence-slice|voice-presence-shape|voice-presence-band/);
});

test('visible Room Mic waveform never consumes local capture events directly', () => {
  assert.doesNotMatch(presence, /relay-local-mic-level/);
  assert.doesNotMatch(presence, /localActive|localStaleTimer|LOCAL_EVIDENCE_STALE_MS/);
  assert.match(presence, /relay-room-mic-presence/);
});

test('Room Mic evidence expires when authoritative telemetry stops instead of freezing forever', () => {
  assert.match(presence, /ROOM_EVIDENCE_STALE_MS = 320/);
  assert.match(presence, /roomStaleTimer = setTimeout/);
  assert.match(presence, /sourceKey !== expectedSourceKey/);
});

test('frequency evidence remains truthful timbre data and is not painted as fake pitch', () => {
  assert.match(capture, /SPECTRUM_FFT_SIZE = 512/);
  assert.match(capture, /\[80, 250\]/);
  assert.match(capture, /\[2000, 4000\]/);
  assert.match(capture, /spectrumBands: this\.measureSpectrumBands\(\)/);
  assert.match(composition, /not[\s\S]*presented as musical pitch until a real F0 estimate exists/);
  assert.doesNotMatch(presence, /WebSocket|mix-health|requestAnimationFrame/);
  assert.doesNotMatch(state, /@keyframes|voice-breathe|preparing-pulse/);
  assert.doesNotMatch(composition, /@keyframes|voice-breathe|preparing-pulse/);
});

test('new Mic evidence stays at exact center while one stored history mirrors outward', () => {
  assert.match(model, /const newestIndex = safeCount - 1/);
  assert.match(model, /left: safeWidth \/ 2 - distance/);
  assert.match(model, /right: safeWidth \/ 2 \+ distance/);
  assert.match(model, /const next = \[\.\.\.previous, createPresenceSlice/);
  assert.match(presence, /const right = history[\s\S]*?\.slice\(0, -1\)[\s\S]*?\.reverse\(\)/);
});

test('performance actions stay in Sing -> Record -> Adjust -> Review order', () => {
  assert.match(composition, /\.performance-stage > \.take-strip \{ order: 5 !important; \}/);
  assert.match(composition, /\.performance-stage > \.mic-live-control \{ order: 6 !important; \}/);
  assert.doesNotMatch(liveIa, /performanceStage\.insertBefore\(lastTake|append(?:Child)?\(lastTake/);
  assert.match(actions, /#start-recording \{[\s\S]*?border: 0;[\s\S]*?background: transparent;/);
  assert.match(composition, /#start-recording:not\(:disabled\)::before[\s\S]*?background:#d8a5a1/);
});

test('recording morphs in place and hides the previous Take until the current Take ends', () => {
  assert.match(composition, /\.take-strip\[data-take-state="recording"\][\s\S]*?grid-template-columns:auto auto/);
  assert.match(composition, /data-take-state="recording"[\s\S]*?#recording-status[\s\S]*?grid-column:1/);
  assert.match(composition, /:has\(\.take-strip\[data-take-state="recording"\]\)[\s\S]*?\.recent-take[\s\S]*?display:none/);
  assert.doesNotMatch(composition, /#stop-recording:not\(:disabled\)::before/);
});

test('Room Mic presence is visible to listeners and self owners through the same room projection', () => {
  assert.match(state, /body\[data-self-mic="live"\] \.voice-copy strong/);
  assert.match(state, /font-size: clamp\(27px, 7vw, 34px\)/);
  assert.match(state, /\.voice-input-evidence \{[\s\S]*?display: none;/);
  assert.match(state, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
  assert.match(state, /body\[data-self-mic="live"\] \.voice-presence-wave[\s\S]*?stroke: rgba\(247, 244, 237, \.82\);/);
  assert.match(presence, /`room:\$\{ownerId\}:\$\{generation\}`/);
  assert.doesNotMatch(presence, /if \(localActive\) return;/);
});

test('forced Room sound state removes the inert slider while preserving the short reason', () => {
  assert.match(composition, /body\[data-listen="mic-muted"\] \.local-sound-control \.adjust-control,[\s\S]*?display:none;/);
  assert.match(composition, /body\[data-listen="mic-muted"\] \.local-sound-control #listen-adjust-state,[\s\S]*?display:block;/);
});
