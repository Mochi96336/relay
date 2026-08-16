import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const liveStatus = readFileSync(new URL('../public/live-status.js', import.meta.url), 'utf8');
const recorder = readFileSync(new URL('../public/recorder.js', import.meta.url), 'utf8');

function position(fragment: string) {
  const index = html.indexOf(fragment);
  assert.notEqual(index, -1, `expected index.html to contain ${fragment}`);
  return index;
}

test('phone home is the Live surface, not the old prototype dashboard', () => {
  assert.match(html, /class="live-shell"/);
  assert.doesNotMatch(html, /RELAY \/ AUDIO PROTOTYPE/);
  assert.doesNotMatch(html, /Phone mic → mixer/);

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

test('engineering source and click-sync controls live below System technical details', () => {
  const system = position('class="system-panel"');
  const diagnostics = position('class="diagnostics-panel"');
  const source = position('Open source');
  const clickTest = position('id="start-sync-test"');
  const legacyStatus = position('class="legacy-status-readout"');
  assert.ok(system < diagnostics);
  assert.ok(diagnostics < source);
  assert.ok(diagnostics < clickTest);
  assert.ok(diagnostics < legacyStatus);
});

test('formal Live copy consumes server product-status instead of rebuilding lifecycle in the browser', () => {
  assert.match(html, /src="\/live-status\.js"/);
  assert.match(liveStatus, /product-status-request/);
  assert.match(liveStatus, /message\.type === 'product-status'/);
  assert.match(liveStatus, /relay-product-status/);
  assert.match(liveStatus, /Keep this phone speaker audible for a moment\./);
  assert.match(liveStatus, /Robot audio unavailable/);
  assert.doesNotMatch(liveStatus, /buildReadiness|buildProductViewModel/);
});

test('formal Listen has its own transport and only pauses timing setup on the singer phone', () => {
  assert.match(html, /src="\/listen\.js"/);
  assert.match(listen, /role:\s*'monitor'/);
  assert.match(listen, /window\.relayActiveRole === 'publisher'/);
  assert.match(listen, /message\.state === 'collecting'/);
  assert.match(listen, /Listen paused for timing setup\./);
  assert.doesNotMatch(listen, /startPublisher\(/);
});

test('Take start availability comes from product actions while Stop remains Take-lifecycle owned', () => {
  assert.match(recorder, /productCanStartTake/);
  assert.match(recorder, /event\.detail\?\.actions\?\.canStartTake === true/);
  assert.match(recorder, /lifecycle !== 'recording'/);
  assert.match(recorder, /Last take ·/);
});

test('legacy monitor transport stays hidden during the migration', () => {
  const legacy = position('class="legacy-transport-controls"');
  const technical = position('class="diagnostics-body"');
  assert.ok(technical < legacy);
});
