import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const song = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');
const state = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');

test('holder YouTube keeps a usable embedded-player floor', () => {
  assert.match(composition, /\.youtube-player-shell \{[\s\S]*?min-height: 200px;/);
  assert.match(composition, /\.youtube-player-shell iframe \{[\s\S]*?min-height: 200px;/);
});

test('observer Song can be compact because it does not host the YouTube transport', () => {
  assert.match(song, /\.song-observer \{[\s\S]*?min-height: 104px;/);
  assert.match(song, /grid-template-columns: minmax\(96px, 30%\) 1fr;/);
  assert.match(song, /data-playback-role="observer"[\s\S]*?\.youtube-player-shell/);
});

test('performance composition uses measured Mic evidence instead of a decorative ribbon', () => {
  assert.match(composition, /\.voice-input-meter \{[\s\S]*?height: 6px;/);
  assert.match(composition, /width: var\(--input-level\);/);
  assert.doesNotMatch(state, /@keyframes|voice-ribbon|voice-breathe|preparing-pulse/);
});

test('Take and the local control horizon stay close to the performance task', () => {
  assert.match(composition, /\.take-strip \{[\s\S]*?margin-top: 18px;[\s\S]*?padding-top: 16px;/);
  assert.match(composition, /\.live-actions \{[\s\S]*?margin-top: 28px;[\s\S]*?padding-top: 14px;/);
});

test('local live Mic gives Voice weight without manufacturing audio motion', () => {
  assert.match(state, /body\[data-self-mic="live"\] \.voice-copy strong/);
  assert.match(state, /font-size: clamp\(38px, 10\.5vw, 52px\)/);
  assert.match(state, /body\[data-self-mic="off"\] \.voice-input-evidence[\s\S]*?display: none;/);
});
