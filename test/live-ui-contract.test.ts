import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const liveState = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const liveComposition = readFileSync(new URL('../public/live-composition.css', import.meta.url), 'utf8');
const liveIa = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const micPresence = readFileSync(new URL('../public/mic-presence.js', import.meta.url), 'utf8');
const songSurface = readFileSync(new URL('../public/song-surface.js', import.meta.url), 'utf8');
const songCss = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');

function position(fragment: string) {
  const index = html.indexOf(fragment);
  assert.notEqual(index, -1, `missing ${fragment}`);
  return index;
}

test('Live keeps real YouTube media before the performance task', () => {
  assert.ok(position('id="youtube-player"') < position('class="performance-stage"'));
  assert.ok(position('class="performance-stage"') < position('class="live-actions"'));
});

test('performance task contains measured input, Mic ownership and Take', () => {
  const stage = position('class="performance-stage"');
  const meter = position('id="mic-input-meter"');
  const mic = position('id="start-publisher"');
  const take = position('class="take-strip"');
  const footer = position('class="live-actions"');
  assert.ok(stage < meter && meter < mic && mic < take && take < footer);
  assert.doesNotMatch(html, /class="voice-ribbon"/);
  assert.match(app, /latestLocalMicLevel\?\.peakDbfs/);
  assert.match(app, /event\.data\?\.type === 'input-level'/);
  assert.doesNotMatch(app, /latestMixHealth\?\.micPeakDbfs/);
  assert.match(liveIa, /import '\.\/mic-presence\.js';/);
  assert.match(micPresence, /relay-local-mic-level/);
  assert.match(micPresence, /event\.detail\?\.rmsDbfs/);
});

test('input presence follows actual self Mic state without fabricated animation', () => {
  assert.match(liveStatus, /document\.body\.dataset\.selfMic/);
  assert.match(liveState, /body\[data-self-mic="off"\] \.voice-input-evidence/);
  assert.match(liveState, /body\[data-self-mic="live"\] \.voice-presence-bar/);
  assert.match(liveComposition, /\.voice-presence-bar/);
  assert.match(liveComposition, /recent time[\s\S]*No fabricated rhythm/);
  assert.doesNotMatch(liveState, /@keyframes|voice-breathe|preparing-pulse/);
  assert.doesNotMatch(liveComposition, /@keyframes|voice-breathe|preparing-pulse/);
});

test('Song keeps exact playback authority and observer-only compact presentation', () => {
  assert.match(songSurface, /t\('song\.role\.holder'\)/);
  assert.match(songSurface, /t\('song\.role\.observer'\)/);
  assert.match(songSurface, /relay:playback-view/);
  assert.match(songCss, /data-playback-role="observer"/);
  assert.doesNotMatch(songSurface, /micOwnerId|participantCount/);
});

test('formal Live still consumes server product state and one Listen transport', () => {
  assert.match(liveStatus, /product-status-request/);
  assert.match(liveStatus, /message\.type === 'product-status'/);
  assert.match(liveStatus, /relay-microphone-start-failed/);
  assert.match(listen, /role:\s*'monitor'/);
  assert.match(listen, /let userMuted = false/);
  assert.match(listen, /let micForcedMuted = false/);
  assert.doesNotMatch(html, /id="start-monitor"|id="monitor-gain"/);
});

test('product attention emits navigation intent while Live IA owns the System sheet', () => {
  assert.match(liveStatus, /window\.dispatchEvent\(new Event\('relay-open-system'\)\)/);
  assert.doesNotMatch(liveStatus, /systemPanel\.open\s*=\s*true|scrollIntoView/,
    'product-state rendering must not own secondary-surface navigation');
  assert.match(liveIa, /window\.addEventListener\('relay-open-system', \(\) => revealPanel\(systemPanel, adjustPanel, closeSystem\)\)/);
  assert.match(liveIa, /function closeTakeHistoryPanel\(\)/);
});