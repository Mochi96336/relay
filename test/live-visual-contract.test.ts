import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const composition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const song = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');
const state = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');

test('Live composition keeps Take contextual and reserves the control horizon for Listen and Adjust', () => {
  assert.match(composition, /\.take-strip \{[\s\S]*?margin-top: 16px;[\s\S]*?text-align: left;/);
  assert.match(composition, /\.live-actions \{[\s\S]*?margin-top: auto;[\s\S]*?padding-top: 18px;/);
});

test('empty and connecting rooms do not manufacture a black media field before a song exists', () => {
  assert.match(song, /data-playback-role="empty"[\s\S]*?\.youtube-player-shell/);
  assert.match(song, /data-playback-role="connecting"[\s\S]*?\.youtube-player-shell/);
});

test('the performance field gains visual weight only for the local live Mic owner', () => {
  assert.match(state, /@import url\('\/live-composition\.css'\);/);
  assert.match(state, /body\[data-self-mic="live"\] \.voice-copy strong/);
  assert.match(state, /font-size: clamp\(38px, 10\.5vw, 52px\)/);
  assert.match(state, /body\[data-self-mic="off"\] \.voice-ribbon span[\s\S]*?opacity: \.24 !important/);
});

test('short phone viewports compress rhythm instead of dropping primary controls below arbitrary whitespace', () => {
  assert.match(composition, /@media \(max-height: 760px\)/);
  assert.match(composition, /\.performance-stage \{ padding-top: 26px; \}/);
  assert.match(composition, /\.take-strip \{ margin-top: 10px; \}/);
});
