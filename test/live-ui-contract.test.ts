import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const liveStateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');
const songSurface = readFileSync(new URL('../public/song-surface.js', import.meta.url), 'utf8');
const songSurfaceCss = readFileSync(new URL('../public/song-surface.css', import.meta.url), 'utf8');
const youtube = readFileSync(new URL('../public/youtube.js', import.meta.url), 'utf8');
const youtubeSync = readFileSync(new URL('../public/youtube-sync.js', import.meta.url), 'utf8');

function position(fragment: string) {
  const index = html.indexOf(fragment);
  assert.notEqual(index, -1, `expected index.html to contain ${fragment}`);
  return index;
}

test('phone home is the Live surface, not the old prototype dashboard', () => {
  assert.match(html, /class="live-shell"/);
  assert.doesNotMatch(html, /RELAY \/ AUDIO PROTOTYPE/);
  assert.doesNotMatch(html, /Phone mic → mixer/);
  assert.doesNotMatch(html, />DJ<|>Host</);

  for (const id of [
    'participant-count',
    'youtube-player',
    'live-state-title',
    'start-publisher',
    'start-recording',
    'listen-toggle',
    'calibrate-timing',
    'system-panel',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
});

test('YouTube remains a real unobscured player surface ahead of Relay performance controls', () => {
  const player = position('id="youtube-player"');
  const voice = position('class="performance-stage"');
  const take = position('class="take-strip"');
  assert.ok(player < voice);
  assert.ok(voice < take);
});

test('Song surface separates the playback holder from room observers without inventing a social role', () => {
  assert.match(html, /href="\/song-surface\.css"/);
  assert.match(html, /src="\/song-surface\.js"/);
  assert.match(html, /id="song-observer"/);
  assert.match(html, /id="song-device-note"/);
  assert.match(html, /id="change-youtube"/);

  assert.match(songSurface, /t\('song\.role\.holder'\)/);
  assert.match(songSurface, /t\('song\.role\.preparing'\)/);
  assert.match(songSurface, /t\('song\.role\.observer'\)/);
  assert.match(songSurface, /relay:playback-view/);
  assert.match(songSurfaceCss, /data-playback-role="observer"/);
});

test('Song authority role comes from exact playback transport state, not participant presence', () => {
  assert.match(youtubeSync, /import \{ resolvePlaybackRole \} from '\.\/song-role\.js'/);
  assert.match(youtubeSync, /transportId/);
  assert.match(youtubeSync, /playbackGeneration/);
  assert.match(youtubeSync, /relay:playback-view/);
  assert.doesNotMatch(songSurface, /micOwnerId|participantCount/);
});

test('observer Song surface is transport-read-only until this page becomes holder or exact handoff target', () => {
  assert.match(youtube, /playbackRole === 'observer'/);
  assert.match(youtube, /source: 'observer-quiet'/);
  assert.match(youtube, /player\.pauseVideo\(\)/);
  assert.match(youtube, /song\.observerCannotChange|Take the mic on this phone before changing the song\./);
  assert.match(songSurface, /playerShell\.hidden = observerMode/);
  assert.match(songSurface, /observer\.hidden = !observerMode/);
});

test('retired development source and click-sync controls are absent from Live', () => {
  for (const retired of [
    'Robot / development source',
    'Open source',
    'start-sync-test',
    'stop-sync-test',
    'Legacy click sync test',
    'class="legacy-tools"',
    'source.html',
  ]) {
    assert.equal(html.includes(retired), false);
  }
});

test('formal Live copy consumes server product-status instead of rebuilding lifecycle in the browser', () => {
  assert.match(html, /src="\/live-status\.js"/);
  assert.match(liveStatus, /product-status-request/);
  assert.match(liveStatus, /message\.type === 'product-status'/);
  assert.match(liveStatus, /relay-product-status/);
  assert.match(liveStatus, /t\('voice\.keepSpeakerAudible'\)/);
  assert.match(liveStatus, /t\('system\.attention\.robot-audio-unavailable'\)/);
  assert.doesNotMatch(liveStatus, /buildReadiness|buildProductViewModel/);
});

test('local Mic permission/start failures surface in the formal Voice field instead of hidden legacy status', () => {
  assert.match(liveStatus, /relay-microphone-start-failed/);
  assert.match(liveStatus, /t\('voice\.micUnavailable'\)/);
  assert.match(liveStatus, /t\('voice\.permissionRequired'\)/);
  assert.match(liveStatus, /t\('voice\.httpsRequired'\)/);
});

test('Voice motion follows product self-Mic state rather than legacy button disabled state', () => {
  const baseStyle = position('href="/style.css"');
  const stateStyle = position('href="/live-state.css"');
  assert.ok(baseStyle < stateStyle, 'product-state presentation must override the legacy base selector');
  assert.match(liveStatus, /document\.body\.dataset\.selfMic/);
  assert.match(liveStateCss, /body\[data-self-mic="live"\] \.voice-ribbon span/);
  assert.match(liveStateCss, /body\[data-self-mic="off"\] \.voice-ribbon span/);
});

test('formal Listen owns local mute state while Mic ownership supplies only a temporary override', () => {
  assert.match(html, /src="\/listen\.js"/);
  assert.match(listen, /role:\s*'monitor'/);
  assert.match(listen, /let userMuted = false/);
  assert.match(listen, /let micForcedMuted = false/);
  assert.match(listen, /relay-microphone-started/);
  assert.match(listen, /relay-microphone-ended/);
  assert.doesNotMatch(listen, /window\.relayActiveRole === 'publisher'/);
  assert.doesNotMatch(listen, /timing-calibration-status/);
  assert.doesNotMatch(listen, /startPublisher\(/);
});

test('Take start availability comes from product actions while Stop remains Take-lifecycle owned', () => {
  assert.match(recorder, /productCanStartTake/);
  assert.match(recorder, /event\.detail\?\.actions\?\.canStartTake === true/);
  assert.match(recorder, /lifecycle !== 'recording'/);
  assert.match(recorder, /t\('take\.last'/);
});

test('formal Listen is the only monitor transport shipped by the Live page', () => {
  assert.doesNotMatch(html, /id="start-monitor"|id="monitor-gain"|legacy-transport-controls/);
  assert.match(listen, /role:\s*'monitor'/);
});