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

test('observer Song is compact without changing holder transport presentation', () => {
  assert.match(song, /\.song-observer \{[\s\S]*?min-height: 104px;/);
  assert.match(song, /grid-template-columns: minmax\(96px, 30%\) 1fr;/);
  assert.match(song, /data-playback-role="observer"[\s\S]*?\.youtube-player-shell/);
  assert.match(song, /data-playback-role="empty"[\s\S]*?\.youtube-player-shell/);
  assert.match(song, /data-playback-role="connecting"[\s\S]*?\.youtube-player-shell/);
});

test('performance composition uses measured Mic evidence instead of decorative motion', () => {
  assert.match(composition, /\.voice-input-meter \{[\s\S]*?height: 6px;/);
  assert.match(composition, /width: var\(--input-level\);/);
  assert.match(state, /body\[data-self-mic="live"\] \.voice-input-meter::before/);
  assert.doesNotMatch(state, /@keyframes|voice-ribbon|voice-breathe|preparing-pulse/);
});

test('Voice headline still breathes across the phone width', () => {
  assert.match(composition, /\.voice-copy strong \{[\s\S]*?max-width: 18ch;/);
});

test('secondary song and System context stays quiet but readable', () => {
  assert.match(composition, /\.song-device-note \{[\s\S]*?color: #85888f;/);
  assert.match(composition, /#youtube-note \{[\s\S]*?color: #7f8289;/);
  assert.match(composition, /\.system-panel > summary \{[\s\S]*?color: #60636a;/);
});

test('local live Mic gains visual weight while off phones do not show input evidence', () => {
  assert.match(state, /body\[data-self-mic="live"\] \.voice-copy strong/);
  assert.match(state, /font-size: clamp\(38px, 10\.5vw, 52px\)/);
  assert.match(state, /body\[data-self-mic="off"\] \.voice-input-evidence[\s\S]*?display: none;/);
  assert.match(state, /body\[data-self-mic="live"\] #youtube-note \{[\s\S]*?display: none;/);
});

test('Take and local controls stay close to the performance task', () => {
  assert.match(composition, /\.take-strip \{[\s\S]*?margin-top: 18px;[\s\S]*?padding-top: 16px;/);
  assert.match(composition, /\.live-actions \{[\s\S]*?margin-top: 28px;[\s\S]*?padding-top: 14px;/);
});

test('short phone viewports compress rhythm without collapsing the YouTube floor', () => {
  assert.match(composition, /@media \(max-height: 760px\)/);
  assert.match(composition, /\.performance-stage \{ padding-top: 22px; \}/);
  assert.match(composition, /\.take-strip \{ margin-top: 14px; padding-top: 13px; \}/);
  assert.match(composition, /\.live-actions \{ margin-top: 24px; padding-top: 12px; \}/);
  assert.doesNotMatch(composition, /@media \(max-height: 760px\)[\s\S]*?youtube-player-shell[\s\S]*?min-height: 0/);
});
