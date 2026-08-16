import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('capture gaps are reported as exact sample deltas without changing the padded timeline', () => {
  const worklet = readFileSync(new URL('../public/capture-worklet.js', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(worklet, /samples: unreported \* RENDER_QUANTUM/);
  assert.match(worklet, /this\.writeSilence\(RENDER_QUANTUM\)/);
  assert.match(worklet, /this\.reportInputGap\(true\)/);
  assert.match(app, /captureInputGapSamples \+= samples/);
  assert.match(app, /type: 'audio-uplink-health'/);
  assert.match(app, /transport: audioTransport\.stats\(\)/);
});

test('readiness samples media connectivity rather than only the control websocket', () => {
  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const readinessStart = server.indexOf('function readinessPayload');
  const readinessEnd = server.indexOf('function productStatusPayload', readinessStart);
  const readiness = server.slice(readinessStart, readinessEnd);
  assert.match(readiness, /micConnected: micMediaConnected\(\)/);
  assert.doesNotMatch(readiness, /micConnected: publisher\?\.readyState === WebSocket\.OPEN/);
});
