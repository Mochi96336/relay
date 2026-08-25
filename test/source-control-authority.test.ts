import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sourceJs = readFileSync(new URL('../public/source.js', import.meta.url), 'utf8');
const sourceHtml = readFileSync(new URL('../public/source.html', import.meta.url), 'utf8');
const appJs = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('Desktop Source no longer exposes authority-bearing singer commands', () => {
  assert.doesNotMatch(sourceJs, /type:\s*'set-mix'/);
  assert.doesNotMatch(sourceJs, /type:\s*'set-vocal-fine-tune'/);
  assert.doesNotMatch(sourceJs, /type:\s*'start-timing-calibration'/);
  assert.match(sourceHtml, /id="source-volume"[^>]*disabled/);
  assert.match(sourceHtml, /id="source-mic-gain"[^>]*disabled/);
  assert.match(sourceHtml, /id="vocal-fine-tune"[^>]*disabled/);
  assert.match(sourceHtml, /id="start-timing-calibration"[^>]*hidden[^>]*disabled/);
});

test('Vocal fine tune lives on the authenticated Mic-owner phone surface', () => {
  assert.match(indexHtml, /id="vocal-fine-tune"[^>]*disabled/);
  assert.match(
    appJs,
    /const actionable = publisherCommandAuthority\(\)\.actionable;[\s\S]*vocalFineTune\.disabled = !actionable/,
  );
  assert.match(
    appJs,
    /function sendVocalFineTune\(\)[\s\S]*if \(!publisherCommandAuthority\(\)\.actionable\)[\s\S]*restoreLastKnownControl\('set-vocal-fine-tune'\)/,
  );
  assert.match(appJs, /type: 'set-vocal-fine-tune'/);
  assert.match(
    appJs,
    /message\.type === 'source-status'[\s\S]*message\.vocalFineTuneMs[\s\S]*vocalFineTune\.value/,
  );
});

test('Source still applies the canonical Song level locally without writing it back', () => {
  assert.match(
    sourceJs,
    /message\.type === 'mix-settings'[\s\S]{0,500}sourceVolume\.value[\s\S]{0,200}applyBalance\(\)/,
  );
  assert.match(sourceJs, /player\.setVolume\(songLevel\)/);
});