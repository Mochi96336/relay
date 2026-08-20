import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const presentation = readFileSync(new URL('../public/room-sound-presentation.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/room-sound-ui.css', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');

test('Listen publishes room-sound truth while Room sound owns the visible projection', () => {
  assert.match(listen, /relay-listen-state/);
  assert.doesNotMatch(listen, /document\.body\.dataset\.listen/);
  assert.doesNotMatch(listen, /listen-adjust-state|listen-note|listen-gain-value/);

  assert.match(ui, /relay-listen-state/);
  assert.match(ui, /roomSoundPresentation/);
  assert.match(ui, /roomSoundStableNote/);
  assert.match(ui, /roomSoundActionNote/);
  assert.match(ui, /document\.body\.dataset\.listen/);
  assert.match(ui, /root\.dataset\.listenPhase/);
  assert.match(ui, /root\.dataset\.listenNote/);
  assert.doesNotMatch(ui, /MutationObserver/);

  for (const forbidden of ['new WebSocket', 'new AudioContext', 'createGain', 'monitorPacketVersion']) {
    assert.equal(ui.includes(forbidden), false, `room-sound-ui.js must not own ${forbidden}`);
  }
});

test('user mute, recovery, and forced pause reasons are product presentation data', () => {
  for (const copy of [
    '房間聲音已靜音',
    '無法啟動房間聲音，再點一下重試',
    '房間聲音重新連線中…',
    '房間聲音緩衝中…',
    '唱歌時暫停',
    '正在接手 Mic…',
    '這支裝置正在播放伴奏',
    '正在播放錄音',
  ]) {
    assert.equal(presentation.includes(copy), true, `missing Room sound copy: ${copy}`);
  }
});

test('Take review is a forced Listen overlay rather than a user mute mutation', () => {
  assert.match(listen, /let takeReviewForcedMuted = false/);
  assert.match(listen, /takeReviewForcedMuted/);
  assert.match(listen, /relay-take-review-playback/);
  assert.match(listen, /setTakeReviewForcedMute\(event\.detail\?\.active === true\)/);
});

test('Room sound keeps stable reasons separate from aria-live action feedback', () => {
  assert.match(css, /#listen-adjust-state \{[\s\S]*?display: none;/);
  assert.match(css, /data-listen-note="visible"[^\n]*#listen-adjust-state/);
  assert.doesNotMatch(css, /data-listen="audible"[^\n]*#listen-adjust-state/);
  assert.match(ui, /stableNote \? 'visible' : 'quiet'/);
  assert.match(ui, /stateNote\.textContent = stableNote/);
  assert.match(ui, /actionNote\.textContent = transientNote/);
  assert.match(html, /id="listen-note"[^>]*aria-live="polite"/);
});
