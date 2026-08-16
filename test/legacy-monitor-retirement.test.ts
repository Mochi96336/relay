import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('app.js owns Mic capture but no longer contains a second monitor runtime', () => {
  assert.match(app, /role:\s*'publisher'/);
  assert.match(app, /framePcm\(event\.data, captureGeneration, firstSampleIndex\)/);
  assert.doesNotMatch(app, /startMonitor|connectMonitorSocket|monitorGainNode|playbackNode|linearResample|int16ToFloat32/);
});

test('formal Listen is the only browser monitor implementation', () => {
  assert.match(listen, /role:\s*'monitor'/);
  assert.match(listen, /playback-processor/);
  assert.doesNotMatch(html, /id="start-monitor"|id="monitor-gain"|legacy-transport-controls/);
});
