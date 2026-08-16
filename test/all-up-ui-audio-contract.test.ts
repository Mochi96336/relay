import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const listen = readFileSync(new URL('../public/listen.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('all-up phone UI keeps #13 singer ownership while using the v2 media plane', () => {
  assert.match(app, /let publisherActive = false/);
  assert.match(app, /setPublisherActive\(true\)/);
  assert.match(app, /new PreferredAudioTransport/);
  assert.match(app, /audioPacketVersion: AUDIO_PACKET_VERSION/);
  assert.match(app, /splitPcmForPacketLimit/);
  assert.match(app, /audioTransport\.maxPacketBytes\(\)/);
  assert.match(app, /audioTransport\.prefer\(/);
  assert.match(app, /audioTransport\.send\(/);
  assert.match(app, /type: 'audio-uplink-health'/);
  assert.match(app, /captureInputGapSamples \+= samples/);

  assert.doesNotMatch(app, /role:\s*'monitor'/);
  assert.doesNotMatch(app, /\bactiveRole\b|setActiveRole/);
  assert.doesNotMatch(app, /connectMonitorSocket|playbackNode|monitorGainNode|linearResample|int16ToFloat32/);
  assert.doesNotMatch(app, /socket\.send\(framePcm\(/);
});

test('Listen remains the sole browser audio-return runtime after the transport transplant', () => {
  assert.match(listen, /role:\s*'monitor'/);
  assert.match(listen, /playback-processor/);
  assert.doesNotMatch(html, /id="start-monitor"|id="monitor-gain"|legacy-transport-controls/);
});
