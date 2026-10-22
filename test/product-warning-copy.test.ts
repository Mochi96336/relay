import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { productIssueTitleKey } from '../public/product-issue-copy.js';

function copy() {
  const window = { dispatchEvent() {} } as any;
  const context = { window, document: { documentElement: { lang: '' }, querySelectorAll: () => [], querySelector: () => null },
    localStorage: { getItem: () => null, setItem() {} }, navigator: { languages: ['en'], language: 'en' },
    CustomEvent: class {} };
  for (const file of ['i18n.js', 'live-i18n.js']) {
    runInNewContext(readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8'), context);
  }
  return window.relayI18n;
}

test('titles distinguish a disconnected Robot page from a video the Robot rejected', () => {
  const i18n = copy(); i18n.setLocale('zh-Hant', { persist: false });
  assert.equal(i18n.t(productIssueTitleKey({ code: 'robot-player-unavailable', cause: 'robot-source-unavailable' })), 'Robot 播放端未連線');
  assert.equal(i18n.t(productIssueTitleKey({ code: 'robot-player-unavailable', cause: 'robot-video-unplayable' })), 'Robot 無法播放這支影片');
});

test('clock loss describes missing progress and suggests a check without promising repair', () => {
  const i18n = copy();
  const key = productIssueTitleKey({ code: 'song-clock-unavailable', cause: 'song-clock-unavailable' });
  assert.equal(i18n.t(key), 'Song progress not updating');
  i18n.setLocale('zh-Hant', { persist: false });
  assert.equal(i18n.t(key), '歌曲進度未更新');
  assert.equal(i18n.t('system.issue.recovery.check-playback'), '請確認播放歌曲的頁面是否仍開啟並連線。');
  assert.equal(i18n.t('system.issue.recovery.automatic'), '收到新資訊後，這裡會自動更新。');
});

test('delayed or intermittent Mic audio and estimated timing retain their observed meaning', () => {
  const i18n = copy(); i18n.setLocale('zh-Hant', { persist: false });
  for (const [cause, expected] of [
    ['mic-uplink-delayed', '麥克風音訊延遲'],
    ['mic-timeline-behind', '麥克風音訊延遲'],
    ['mic-audio-intermittent', '麥克風音訊不連續'],
    ['backing-not-ready', '伴奏正在準備中'],
    ['timing-calibrating', '正在測量時間對齊'],
    ['timing-fallback', '時間對齊目前使用估計'],
  ]) assert.equal(i18n.t(productIssueTitleKey({ cause })), expected);
  assert.equal(productIssueTitleKey({ code: 'audio-unavailable' }), 'system.attention.audio-unavailable', 'older attention-only messages retain a title');
  assert.equal(productIssueTitleKey({ code: 'future-issue' }), 'system.attention');
  assert.equal(productIssueTitleKey({ code: 'timing-recovering', cause: 'timing-fallback', recovery: 'recalibrate-after-take' }),
    'system.attention.timing-estimated');
  assert.equal(productIssueTitleKey({ code: 'timing-clamped', cause: 'timing-clamped', recovery: 'recalibrate-after-take' }),
    'system.attention.timing-clamped', 'a recording must not hide a measured clamp behind an estimate label');
  assert.equal(productIssueTitleKey({ code: 'timing-recovering', cause: 'timing-stale', recovery: 'recalibrate-after-take' }),
    'system.attention.timing-recovering', 'stale alignment alone does not prove which timing a recording is using');
});
