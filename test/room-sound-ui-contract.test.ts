import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const ui = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/room-sound-ui.css', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('Listen publishes room-sound truth while Room sound owns the visible projection', () => {
  assert.match(listen, /relay-listen-state/);
  assert.doesNotMatch(listen, /document\.body\.dataset\.listen/);
  assert.doesNotMatch(listen, /listen-adjust-state|listen-note|listen-gain-value/);

  assert.match(ui, /relay-listen-state/);
  assert.match(ui, /document\.body\.dataset\.listen/);
  assert.doesNotMatch(ui, /MutationObserver/);

  for (const forbidden of ['new WebSocket', 'new AudioContext', 'createGain', 'monitorPacketVersion']) {
    assert.equal(ui.includes(forbidden), false, `room-sound-ui.js must not own ${forbidden}`);
  }
});

test('user mute and forced pause reasons are human product language', () => {
  assert.match(ui, /'房間聲音已靜音'/);
  assert.match(ui, /'唱歌時暫停'/);
  assert.match(ui, /'這支裝置正在播放伴奏'/);
  assert.match(ui, /'正在播放錄音'/);
  assert.match(ui, /state === 'muted'/);
  assert.match(ui, /state === 'mic-muted'/);
  assert.match(ui, /state === 'playback-muted'/);
  assert.match(ui, /state === 'review-muted'/);
});

test('Take review is a forced Listen overlay rather than a user mute mutation', () => {
  assert.match(listen, /let takeReviewForcedMuted = false/);
  assert.match(listen, /takeReviewForcedMuted/);
  assert.match(listen, /relay-take-review-playback/);
  assert.match(listen, /setTakeReviewForcedMute\(event\.detail\?\.active === true\)/);
});

test('only non-routine Room sound reasons occupy a persistent status row', () => {
  assert.match(css, /body\[data-listen="muted"\] #listen-adjust-state/);
  assert.match(css, /body\[data-listen="mic-muted"\] #listen-adjust-state/);
  assert.match(css, /body\[data-listen="playback-muted"\] #listen-adjust-state/);
  assert.match(css, /body\[data-listen="review-muted"\] #listen-adjust-state/);
  assert.doesNotMatch(css, /data-listen="audible"[^\n]*#listen-adjust-state/);
});
