import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const song = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');
const state = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const presence = readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8');
const model = readFileSync(new URL('../public/mic-presence-model.js', import.meta.url), 'utf8');
const capture = readFileSync(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');

test('holder YouTube stays real, compact and above a usable embedded-player floor', () => {
  assert.match(composition, /\.youtube-player-shell \{[\s\S]*?width: 100%;[\s\S]*?min-height: 200px;[\s\S]*?aspect-ratio: 16 \/ 9;/);
  assert.match(composition, /\.youtube-player-shell iframe \{[\s\S]*?width: 100%;[\s\S]*?height: 100%;[\s\S]*?min-height: 200px;/);
});

test('observer Song is a compact room snapshot because it does not host YouTube transport', () => {
  assert.match(song, /\.song-observer \{[\s\S]*?min-height: 92px;/);
  assert.match(song, /grid-template-columns: 92px minmax\(0, 1fr\);/);
  assert.match(song, /data-playback-role="observer"[\s\S]*?\.youtube-player-shell/);
});

test('holder Change song is visible as a real phone touch target instead of tiny utility text', () => {
  assert.match(song, /#change-youtube \{[\s\S]*?min-height: 44px;[\s\S]*?padding: 0 12px;/);
  assert.match(song, /data-playback-role="holder"\]\[data-song-editing="false"\] \.youtube-form[\s\S]*?display: none;/);
});

test('performance composition renders one continuous spectral Mic contour', () => {
  assert.match(composition, /\.voice-input-meter \{[\s\S]*?width: min\(72vw, 282px\);[\s\S]*?height: 60px;[\s\S]*?grid-template-columns: repeat\(10, minmax\(0,1fr\)\);[\s\S]*?gap: 0;/);
  assert.match(composition, /mask-image: linear-gradient\(to right, transparent 0%, #000 12%, #000 100%\)/);
  assert.match(composition, /\.voice-presence-slice \{[\s\S]*?position: relative;[\s\S]*?height: 60px;/);
  assert.match(composition, /\.voice-presence-shape \{[\s\S]*?position: absolute;[\s\S]*?width: calc\(100% \+ 2px\);/);
  assert.match(model, /MIC_PRESENCE_SLICE_COUNT = 10/);
  assert.match(model, /MIC_PRESENCE_BAND_COUNT = 5/);
  assert.match(model, /presenceSliceGeometry/);
  assert.match(presence, /LOCAL_SAMPLE_INTERVAL_MS = 40/);
  assert.match(liveStatus, /MIC_PRESENCE_TELEMETRY_INTERVAL_MS = 80/);
  assert.match(presence, /event\.detail\?\.spectrumBands/);
});

test('local Mic evidence expires if the capture worklet stops producing samples', () => {
  assert.match(presence, /LOCAL_EVIDENCE_STALE_MS = 160/);
  assert.match(presence, /localStaleTimer = setTimeout/);
});

test('listener Room Mic evidence expires when telemetry stops instead of freezing forever', () => {
  assert.match(presence, /REMOTE_EVIDENCE_STALE_MS = 320/);
  assert.match(presence, /remoteStaleTimer = setTimeout/);
  assert.match(presence, /sourceKey !== expectedSourceKey/);
});

test('frequency shape originates in the singer capture worklet rather than final room mix or fake animation', () => {
  assert.match(capture, /SPECTRUM_FFT_SIZE = 512/);
  assert.match(capture, /\[80, 250\]/);
  assert.match(capture, /\[2000, 4000\]/);
  assert.match(capture, /spectrumBands: this\.measureSpectrumBands\(\)/);
  assert.doesNotMatch(presence, /WebSocket|mix-health|requestAnimationFrame/);
  assert.doesNotMatch(state, /@keyframes|voice-breathe|preparing-pulse/);
  assert.doesNotMatch(composition, /@keyframes|voice-breathe|preparing-pulse/);
});

test('new Mic evidence enters on the right while old evidence fades toward the left', () => {
  assert.match(model, /Oldest slice stays on the left; the newest local Mic evidence enters on the[\s\S]*right/);
  assert.match(model, /const next = \[\.\.\.previous, createPresenceSlice/);
  assert.match(presence, /newest is always the right edge/);
  assert.match(presence, /0\.28 \+ age \* 0\.72/);
});

test('recording stays inside performance while local sound remains the one persistent lower horizon', () => {
  assert.match(composition, /\.take-strip \{[\s\S]*?margin-top: 14px;[\s\S]*?padding-top: 0;[\s\S]*?border-top: 0;/);
  assert.match(composition, /\.live-actions \{[\s\S]*?margin-top:24px;[\s\S]*?padding-top:14px;/);
  assert.match(composition, /data-take-state="recording"[\s\S]*?\.last-take[\s\S]*?display:none;/);
  assert.doesNotMatch(composition, /#stop-recording:not\(:disabled\)::before/);
});

test('Room Mic presence is visible to listeners while local holder evidence stays strongest', () => {
  assert.match(state, /body\[data-self-mic="live"\] \.voice-copy strong/);
  assert.match(state, /font-size: clamp\(27px, 7vw, 34px\)/);
  assert.match(state, /\.voice-input-evidence \{[\s\S]*?display: none;/);
  assert.match(state, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
  assert.match(presence, /if \(localActive\) return;/);
});

test('forced Room sound state removes the inert slider while preserving the short reason', () => {
  assert.match(composition, /body\[data-listen="mic-muted"\] \.local-sound-control \.adjust-control,[\s\S]*?display:none;/);
  assert.match(composition, /body\[data-listen="mic-muted"\] \.local-sound-control #listen-adjust-state,[\s\S]*?display:block;/);
});
