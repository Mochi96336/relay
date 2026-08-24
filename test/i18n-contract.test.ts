import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('locale stays local to this phone and switches without navigation', () => {
  const i18n = read('public/i18n.js');
  assert.equal(i18n.includes('relay.locale.v1'), true);
  assert.equal(i18n.includes('navigator.languages'), true);
  assert.equal(i18n.includes('relay-locale-changed'), true);
  assert.equal(i18n.includes('location.reload'), false);
  assert.equal(i18n.includes('WebSocket'), false);
});

test('locale loads before product runtimes and remains a header secondary control', () => {
  const html = read('public/index.html');
  const locale = html.indexOf('<script src="/i18n.js"></script>');
  const presence = html.indexOf('src="/presence.js"');
  assert.ok(locale >= 0);
  assert.ok(presence > locale);
  assert.equal(html.includes('class="locale-control"'), true);
  assert.equal(html.includes('data-relay-locale="zh-Hant"'), true);
  assert.equal(html.includes('data-relay-locale="en"'), true);
});

test('product surfaces localize while Technical details and Raw stay technical', () => {
  const html = read('public/index.html');
  assert.equal(html.includes('data-i18n="song.label"'), true);
  assert.equal(html.includes('data-i18n="voice.label"'), true);
  assert.equal(html.includes('data-i18n="take.record"'), true);
  assert.equal(html.includes('data-i18n="system.summary"'), true);
  assert.equal(html.includes('>Technical details<'), true);
  assert.equal(html.includes('>Raw<'), true);
  assert.equal(html.includes('data-i18n="diagnostics.raw"'), false);
});

test('dynamic product copy rerenders when locale changes', () => {
  for (const path of [
    'public/presence.js',
    'public/live-status.js',
    'public/mic-actions.js',
    'public/room-sound-ui.js',
    'public/recording-ui.js',
    'public/take-history.js',
    'public/song-surface.js',
    'public/youtube.js',
    'public/app.js',
    'public/system-details.js',
  ]) {
    assert.equal(read(path).includes('relay-locale-changed'), true, path);
  }
});

test('empty Song copy keeps voice-only Mic and Take legitimate', () => {
  const i18n = read('public/i18n.js');
  assert.equal(i18n.includes("'voice.addSongToBegin': 'Take the mic, or add a song for backing.'"), true);
  assert.equal(i18n.includes("'voice.addSongToBegin': '可以直接拿 Mic，或加入歌曲作伴奏。'"), true);
});

test('locale is not room authority or a protocol command', () => {
  const i18n = read('public/i18n.js');
  assert.equal(i18n.includes('socket.send'), false);
  assert.equal(i18n.includes('relayActiveRole'), false);
  const youtube = read('public/youtube.js');
  const localeHandler = youtube.slice(youtube.indexOf("window.addEventListener('relay-locale-changed'"));
  assert.equal(localeHandler.includes('requestRoomSongCommand('), false,
    'locale rerender must not synthesize room song commands');
});

test('release-era Mic, feedback, and Take history review stay inside the locale boundary', () => {
  const i18n = read('public/i18n.js');
  const live = read('public/live-status.js');
  const roomSound = read('public/room-sound-ui.js');
  const roomSoundPresentation = read('public/room-sound-presentation.js');
  const history = read('public/take-history.js');

  assert.match(i18n, /'voice\.startingYours':/);
  assert.match(i18n, /'voice\.interruptedYours':/);
  assert.match(
    i18n,
    /'voice\.useSpeaker': 'Keep the sound playing aloud so Relay can hear the playback correctly\.'/,
  );
  assert.match(
    i18n,
    /'voice\.useSpeaker': '保持外放，Relay 才能正確聽到播放內容。'/,
  );
  assert.match(i18n, /'voice\.keepSpeakerAudible': '請讓喇叭保持有聲。'/);
  assert.match(i18n, /'system\.attention\.mic-audio-stalled':/);
  assert.match(i18n, /'take\.reviewReleaseMic':/);
  assert.match(i18n, /'take\.reviewPausedForMic':/);
  assert.match(live, /t\('voice\.startingYours'\)/);
  assert.match(live, /t\('voice\.interruptedYours'\)/);
  assert.match(live, /t\('voice\.useSpeaker'\)/);
  assert.doesNotMatch(i18n, /headphones|耳機/i);
  const sourceHtml = read('public/source.html');
  assert.match(sourceHtml, /校準和唱歌時請保持外放，Relay 才能正確聽到播放內容。/);
  assert.doesNotMatch(sourceHtml, /耳機/);
  assert.match(roomSound, /roomSoundPresentation/);
  assert.match(roomSoundPresentation, /state === 'mic-muted'/);
  assert.match(roomSoundPresentation, /'Paused while you sing\.', '唱歌時暫停'/);
  assert.match(roomSoundPresentation, /state === 'playback-muted'/);
  assert.match(roomSoundPresentation, /This device is playing the backing track\./);
  assert.match(roomSoundPresentation, /這支裝置正在播放伴奏/);
  assert.match(roomSoundPresentation, /state === 'review-muted'/);
  assert.match(roomSoundPresentation, /Take playback is playing\./);
  assert.match(roomSoundPresentation, /正在播放錄音/);
  assert.match(history, /window\.addEventListener\('relay-locale-changed', renderHistory\)/);
  assert.match(history, /localCopy\('Release mic before playing a recording\.', '請先放 Mic，再播放錄音。'\)/);
  assert.match(history, /'Recording playback paused while this phone has the mic\.'/);
  assert.match(history, /'這支手機拿到 Mic，錄音播放已暫停。'/);
  assert.doesNotMatch(read('public/recorder.js'), /take\.reviewReleaseMic|take\.reviewPausedForMic/,
    'recording lifecycle must not regain Take review copy ownership');
});
