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

test('dynamic visible presenters rerender when locale changes', () => {
  for (const path of [
    'public/live-status.js',
    'public/mic-actions.js',
    'public/people-ui.js',
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
  assert.equal(read('public/presence.js').includes('relay-locale-changed'), false,
    'Presence is authority, not a visible presenter');
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

test('touched Live product copy is centralized on relayI18n with complete en and zh-Hant', () => {
  const liveCopy = read('public/live-i18n.js');
  const micActions = read('public/mic-actions.js');
  const people = read('public/people-ui.js');
  const recording = read('public/recording-ui.js');
  const roomSound = read('public/room-sound-ui.js');
  const roomSoundPresentation = read('public/room-sound-presentation.js');

  for (const key of [
    'mic.take',
    'mic.release',
    'mic.takeover',
    'mic.takeoverPrompt',
    'people.inRoom',
    'recording.record',
    'recording.failed',
    'recording.blocked.reconnecting',
    'roomSound.label',
  ]) {
    assert.equal((liveCopy.match(new RegExp(`'${key.replaceAll('.', '\\.')}':`, 'g')) ?? []).length, 2, key);
  }

  assert.match(liveCopy, /'mic\.release': '放 Mic'/);
  assert.match(liveCopy, /'mic\.takeover': '接手 Mic'/);
  assert.match(liveCopy, /'mic\.takeoverPrompt': '目前是 \{name\} 在使用 Mic。'/);
  assert.match(liveCopy, /'recording\.failed': '錄音未完成'/);
  assert.match(liveCopy, /'roomSound\.label': '房間聲音'/);

  for (const source of [micActions, people, recording, roomSound]) {
    assert.match(source, /relayI18n\?\.t/);
    assert.doesNotMatch(source, /function chinese|localCopy\(/);
  }
  assert.doesNotMatch(roomSoundPresentation, /isChinese|traditionalChinese|function copy\(/);
});

test('release-era voice feedback stays inside the locale boundary', () => {
  const i18n = read('public/i18n.js');
  const live = read('public/live-status.js');

  assert.match(i18n, /'voice\.startingYours':/);
  assert.match(i18n, /'voice\.interruptedYours':/);
  assert.match(i18n, /'voice\.useSpeaker': 'Keep the sound playing aloud so Relay can hear the playback correctly\.'/);
  assert.match(i18n, /'voice\.useSpeaker': '保持外放，Relay 才能正確聽到播放內容。'/);
  assert.match(i18n, /'voice\.keepSpeakerAudible': '請讓喇叭保持有聲。'/);
  assert.match(i18n, /'system\.attention\.mic-audio-stalled':/);
  assert.match(live, /t\('voice\.startingYours'\)/);
  assert.match(live, /t\('voice\.interruptedYours'\)/);
  assert.match(live, /t\('voice\.useSpeaker'\)/);
  assert.doesNotMatch(i18n, /headphones|耳機/i);
  const sourceHtml = read('public/source.html');
  assert.match(sourceHtml, /校準和唱歌時請保持外放，Relay 才能正確聽到播放內容。/);
  assert.doesNotMatch(sourceHtml, /耳機/);
  assert.doesNotMatch(read('public/recorder.js'), /take\.reviewReleaseMic|take\.reviewPausedForMic/,
    'recording lifecycle must not regain Take review copy ownership');
});

test('Take History keeps recording review wording inside its own locale boundary', () => {
  const history = read('public/take-history.js');
  assert.match(history, /window\.addEventListener\('relay-locale-changed', renderHistory\)/);
  assert.match(history, /localCopy\('Release mic before playing a recording\.', '請先放 Mic，再播放錄音。'\)/);
  assert.match(history, /'Recording playback paused while this phone has the mic\.'/);
  assert.match(history, /'這支手機拿到 Mic，錄音播放已暫停。'/);
});
