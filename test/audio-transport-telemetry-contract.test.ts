import assert from 'node:assert/strict';
import test from 'node:test';

import {
  functionCode,
  readSourceContract,
  sourceCode,
} from './support/source-contract.js';

test('capture gaps are reported as exact sample deltas without changing the padded sample count', () => {
  const worklet = readSourceContract('public/capture-worklet.js');
  const app = readSourceContract('public/app.js');
  const workletCode = sourceCode(worklet);
  const appCode = sourceCode(app);
  const workletHandler = functionCode(app, 'handleCaptureWorkletMessage');

  assert.match(workletCode, /samples: unreported \* RENDER_QUANTUM/);
  assert.match(workletCode, /this\.writeInputGap\(RENDER_QUANTUM\)/);
  assert.match(workletCode, /this\.reportInputGap\(true\)/);
  assert.match(appCode, /captureInputGapSamples \+= samples/);
  assert.match(appCode, /inputGapActive:\s*micCaptureRecovery\.status\(\)\.inputGapActive/);
  assert.match(
    workletHandler,
    /if \(event\.data\?\.type === 'input-gap'\)[\s\S]*?noteInputGap\(captureSnapshot\(\),[\s\S]*?sendAudioUplinkHealth\(\)/,
    'both sustained-gap and recovery edges must reach server source authority immediately',
  );
  assert.match(appCode, /type: 'audio-uplink-health'/);
  assert.match(appCode, /transport: \{ \.\.\.audioTransport\.stats\(\), codec: publisherSession\.encoder \? 'opus' : 'pcm16'/);
});

test('readiness samples media connectivity rather than only the control websocket', () => {
  const server = readSourceContract('src/server.ts');
  const readiness = functionCode(server, 'readinessPayload');
  assert.match(readiness, /micConnected: micMediaConnected\(\)/);
  assert.doesNotMatch(readiness, /micConnected: publisher\?\.readyState === WebSocket\.OPEN/);
});
