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
const capture = readFileSync(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
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

test('performance task contains current Mic evidence, ownership, Mic gain and recording', () => {
  const stage = position('class="performance-stage"');
  const meter = position('id="mic-input-meter"');
  const mic = position('id="start-publisher"');
  const gain = position('id="mic-live-control"');
  const take = position('class="take-strip"');
  const footer = position('class="live-actions"');
  assert.ok(stage < meter && meter < mic && mic < gain && gain < take && take < footer);
  assert.match(app, /latestLocalMicLevel\?\.peakDbfs/);
  assert.match(app, /event\.data\?\.type === 'input-level'/);
  assert.match(app, /spectrumBands/);
  assert.doesNotMatch(app, /latestMixHealth\?\.micPeakDbfs/);
  assert.equal(liveIa.includes("'./mic-presence.js'"), true);
  assert.match(liveIa, /import\(modulePath\)\.catch/);
  assert.match(micPresence, /relay-local-mic-level/);
  assert.match(micPresence, /relay-room-mic-presence/);
  assert.match(micPresence, /event\.detail\?\.spectrumBands/);
});

test('input ribbon follows the actual Room Mic without fabricated animation', () => {
  assert.match(liveStatus, /document\.body\.dataset\.selfMic/);
  assert.match(liveStatus, /document\.body\.dataset\.roomMic/);
  assert.match(liveState, /\.voice-input-evidence \{[\s\S]*?display: none;/);
  assert.match(liveState, /body\[data-room-mic="live"\] \.voice-input-evidence[\s\S]*?display: flex;/);
  assert.match(liveState, /body\[data-room-mic="live"\] \.voice-presence-band/);
  assert.match(micPresence, /if \(localActive\) return;/);
  assert.match(liveComposition, /\.voice-presence-slice/);
  assert.match(liveComposition, /five broad[\s\S]*frequency bands/);
  assert.match(capture, /spectrumBands: this\.measureSpectrumBands\(\)/);
  assert.doesNotMatch(liveState, /@keyframes|voice-breathe|preparing-pulse/);
  assert.doesNotMatch(liveComposition, /@keyframes|voice-breathe|preparing-pulse/);
});

test('Mic gain is contextual and generic Adjust no longer exists', () => {
  assert.match(html, /id="mic-live-control"/);
  assert.doesNotMatch(html, /class="adjust-panel"|id="open-adjust"/);
  assert.match(liveIa, /micLiveLabel\.textContent = 'Mic'/);
  assert.match(liveIa, /relay-microphone-local-state/);
});

test('Song composition follows playback authority instead of Mic or participant heuristics', () => {
  assert.match(songSurface, /t\('song\.role\.holder'\)/);
  assert.match(songSurface, /t\('song\.role\.observer'\)/);
  assert.match(songSurface, /relay:playback-view/);
  assert.match(songSurface, /const holderWithSong = role === 'holder' && Boolean\(videoId\);/);
  assert.match(songSurface, /changeButton\.hidden = !holderWithSong;/);
  assert.match(songSurface, /playerShell\.hidden = observerMode;/);
  assert.match(songSurface, /form\.hidden = role === 'preparing'/);
  assert.match(songCss, /data-playback-role="observer"/);
  assert.doesNotMatch(songSurface, /micOwnerId|participantCount/);
});

test('normal Song state stays quiet while transition and recovery context remains visible', () => {
  assert.match(songSurface, /const visible = recoverable \|\| role === 'preparing' \|\| role === 'connecting';/);
  assert.match(songSurface, /deviceNote\.hidden = !visible;/);
  assert.match(songSurface, /stage\.dataset\.songEditing = editing \? 'true' : 'false';/);
  assert.match(songSurface, /changeButton\.setAttribute\('aria-expanded', editing \? 'true' : 'false'\);/);
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

test('product attention emits navigation intent while Live IA alone owns the System sheet', () => {
  assert.match(liveStatus, /window\.dispatchEvent\(new Event\('relay-open-system'\)\)/);
  assert.doesNotMatch(liveStatus, /systemPanel\.open\s*=\s*true|scrollIntoView/);
  assert.match(liveIa, /window\.addEventListener\('relay-open-system', revealSystem\)/);
  assert.match(liveIa, /function closeTakeHistoryPanel\(\)/);
  assert.doesNotMatch(liveIa, /adjustPanel|openAdjust|closeAdjust/);
});
