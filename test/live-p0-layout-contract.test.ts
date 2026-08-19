import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const stateCss = readFileSync(new URL('../public/live-state.css', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/live-p0-layout.css', import.meta.url), 'utf8');
const roomUi = readFileSync(new URL('../public/room-sound-ui.js', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./fixtures/live-p0-layout.html', import.meta.url), 'utf8');

test('P0 layout repair is render-blocking and owns one shared Live inline track', () => {
  assert.match(stateCss, /@import url\('\/live-p0-layout\.css'\);/);
  assert.match(layoutCss, /--live-inline:\s*20px/);
  assert.match(layoutCss, /grid-template-columns:\s*\[live-left\]\s*minmax\(0, 1fr\)\s*\[live-right\]/);
  assert.match(layoutCss, /\.live-shell\s*\{[\s\S]*?padding-inline:\s*var\(--live-inline\)/);
  assert.match(layoutCss, /\.live-shell > \.song-stage,[\s\S]*?\.live-shell > \.live-actions[\s\S]*?grid-column:\s*live-left \/ live-right/);
  assert.match(layoutCss, /\.youtube-player-shell,[\s\S]*?min-width:\s*0/);
});

test('Take History spends phone width on time and only constrains itself on desktop', () => {
  assert.match(layoutCss, /\.take-history-panel\[open\] > \.take-history-sheet \{[\s\S]*?width:\s*100vw;[\s\S]*?max-width:\s*none;[\s\S]*?margin-inline:\s*0;/);
  assert.match(layoutCss, /padding-left:\s*var\(--live-inline\);[\s\S]*?padding-right:\s*var\(--live-inline\)/);
  assert.match(layoutCss, /\.take-history-item \{[\s\S]*?min-height:\s*64px/);
  assert.match(layoutCss, /\.take-history-item::after \{[\s\S]*?height:\s*2px/);
  assert.match(layoutCss, /#recording-player \{[\s\S]*?min-height:\s*44px/);
  assert.match(layoutCss, /@media \(min-width:\s*760px\)[\s\S]*?width:\s*min\(720px, calc\(100vw - 48px\)\)/);
});

test('Room sound is one 44px local control row with a 2px visual rail', () => {
  assert.match(layoutCss, /\.local-sound-control \{[\s\S]*?height:\s*44px;[\s\S]*?min-height:\s*44px;[\s\S]*?grid-template-columns:\s*44px minmax\(0, 1fr\) auto/);
  assert.match(layoutCss, /\.adjust-group-heading,[\s\S]*?\.adjust-control,[\s\S]*?\.adjust-row-heading \{[\s\S]*?display:\s*contents/);
  assert.match(layoutCss, /#listen-gain \{[\s\S]*?height:\s*44px/);
  assert.match(layoutCss, /#listen-gain::\-webkit-slider-runnable-track \{[\s\S]*?height:\s*2px/);
  assert.match(layoutCss, /#local-listen-label,[\s\S]*?#listen-note \{[\s\S]*?display:\s*none/);
  assert.match(layoutCss, /data-room-sound-value="visible"[\s\S]*?#listen-gain-value/);
});

test('Room sound projection is icon-first, accessible, concise, and remains presentation-only', () => {
  assert.match(roomUi, /setAttribute\('aria-label', '房間聲音'\)/);
  assert.match(roomUi, /\? '🔇' : '🔊'/);
  for (const copy of ['唱歌中', '伴奏', '已靜音']) {
    assert.equal(roomUi.includes(copy), true, `missing compact Room sound state: ${copy}`);
  }
  assert.match(roomUi, /root\.dataset\.listenNote = presentation\.note \? 'visible' : 'quiet'/);
  assert.match(roomUi, /root\.dataset\.roomSoundState = compactNote \? 'visible' : 'quiet'/);
  for (const forbidden of ['new WebSocket', 'new AudioContext', 'createGain', 'monitorPacketVersion']) {
    assert.equal(roomUi.includes(forbidden), false, `Room sound presenter must not own ${forbidden}`);
  }
});

test('390x844 visual fixture names all required repair states', () => {
  for (const state of [
    'empty',
    'listener',
    'singer',
    'recording',
    'take-history-one',
    'take-history-many',
    'room-sound-normal',
    'room-sound-muted',
    'room-sound-forced',
  ]) {
    assert.equal(fixture.includes(state), true, `missing P0 visual state: ${state}`);
  }
  assert.match(fixture, /aria-label="房間聲音"/);
  assert.match(fixture, /Selected Take playback/);
  assert.match(fixture, /min-width:44px; min-height:44px/);
});
