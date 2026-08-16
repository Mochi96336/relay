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

test('locale loads before product runtimes and the switch stays inside the people popover', () => {
  const html = read('public/index.html');
  const locale = html.indexOf('<script src="/i18n.js"></script>');
  const presence = html.indexOf('<script src="/presence.js"></script>');
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
    'public/listen.js',
    'public/recorder.js',
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