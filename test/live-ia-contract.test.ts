import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/live-ia.css', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/live-ia.js', import.meta.url), 'utf8');
const i18n = readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8');

function between(start: string, end: string) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `expected ${start} before ${end}`);
  return html.slice(from, to);
}

test('People owns identity and presence while language/secondary controls live in More', () => {
  const people = between('class="people-menu"', 'id="room-more"');
  const more = between('id="room-more"', '</header>');

  assert.equal(people.includes('id="identity-name"'), true);
  assert.equal(people.includes('id="participant-list"'), true);
  assert.equal(people.includes('data-relay-locale'), false);

  assert.equal(more.includes('data-relay-locale="zh-Hant"'), true);
  assert.equal(more.includes('id="open-adjust"'), true);
  assert.equal(more.includes('id="open-system"'), true);
});

test('Live keeps Song then performance state, with Voice label demoted from navigation', () => {
  const song = html.indexOf('class="song-stage"');
  const performance = html.indexOf('class="performance-stage"');
  const take = html.indexOf('class="take-strip"');
  assert.ok(song >= 0 && song < performance && performance < take);
  assert.equal(html.includes('id="youtube-player"'), true, 'real YouTube surface remains in the Live composition');
  assert.equal(css.includes('.performance-stage > .section-label'), true);
  assert.equal(css.includes('clip-path: inset(50%);'), true,
    'Voice remains accessible without acting as a visible backend-shaped section');
});

test('persistent Live footer exposes only this-phone sound', () => {
  const footer = between('<footer class="live-actions">', '</footer>');
  assert.equal(footer.includes('id="listen-toggle"'), true);
  assert.equal(footer.includes('data-i18n="adjust.thisPhone"'), true);
  assert.equal(footer.includes('class="adjust-panel"'), false);
  assert.equal(footer.includes('id="system-panel"'), false);
});

test('Adjust and System remain reachable, hidden by default, and mutually exclusive', () => {
  assert.equal(css.includes('.adjust-panel > summary,\n.system-panel > summary {\n  display: none;'), true);
  assert.equal(css.includes('.adjust-panel:not([open]),\n.system-panel:not([open]) {\n  display: none;'), true);
  assert.equal(script.includes("openAdjust?.addEventListener('click', () => revealPanel(adjustPanel, systemPanel));"), true);
  assert.equal(script.includes("openSystem?.addEventListener('click', () => revealPanel(systemPanel, adjustPanel));"), true);
  assert.equal(script.includes('if (adjustPanel.open && systemPanel) systemPanel.open = false;'), true);
  assert.equal(script.includes('if (systemPanel.open && adjustPanel) adjustPanel.open = false;'), true);
  assert.equal(html.includes('id="close-adjust"'), true);
  assert.equal(html.includes('id="close-system"'), true);
});

test('English keeps Take while Traditional Chinese uses recording-oriented product copy', () => {
  const englishStart = i18n.indexOf('en: {');
  const chineseStart = i18n.indexOf("'zh-Hant': {");
  assert.ok(englishStart >= 0 && chineseStart > englishStart);
  const english = i18n.slice(englishStart, chineseStart);
  const chinese = i18n.slice(chineseStart);

  assert.equal(english.includes("'take.record': 'Record take'"), true);
  assert.equal(english.includes("'take.lastReady': 'Last take'"), true);
  assert.equal(chinese.includes("'take.record': '開始錄音'"), true);
  assert.equal(chinese.includes("'take.lastReady': '上一段錄音'"), true);
  assert.equal(chinese.includes("'take.record': '錄製 Take'"), false);
  assert.equal(chinese.includes("'system.attention.take-failed': '錄音失敗'"), true);
});

test('Live IA does not reconstruct room or audio authority', () => {
  for (const forbidden of [
    'product-status',
    'mix-health',
    'micPeakDbfs',
    '/readyz',
    '/statusz',
    'WebSocket',
    'getUserMedia',
  ]) {
    assert.equal(script.includes(forbidden), false, `live-ia.js must not own ${forbidden}`);
  }
});

test('header and secondary controls retain real phone-sized touch targets', () => {
  assert.equal(css.includes('.people-menu > summary {\n  min-height: 44px;'), true);
  assert.equal(css.includes('.more-menu > summary {\n  min-width: 44px;\n  min-height: 44px;'), true);
  assert.equal(css.includes('.more-popover .locale-option {\n  min-width: 44px;\n  min-height: 44px;'), true);
  assert.equal(css.includes('.more-action {'), true);
  assert.equal(css.includes('.panel-done {'), true);
});
