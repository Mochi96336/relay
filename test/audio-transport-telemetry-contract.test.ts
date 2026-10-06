import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

test('capture gaps are reported as exact sample deltas without changing the padded sample count', () => {
  const worklet = parseTypeScriptSource(
    new URL('../public/capture-worklet.js', import.meta.url),
    readFileSync(new URL('../public/capture-worklet.js', import.meta.url), 'utf8'),
  );
  const app = parseTypeScriptSource(
    new URL('../public/app.js', import.meta.url),
    readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'),
  );
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
  assert.match(appCode, /transport: audioTransport\.stats\(\)/);
});

test('readiness samples media connectivity rather than only the control websocket', () => {
  const server = parseTypeScriptSource(
    new URL('../src/server.ts', import.meta.url),
    readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
  );
  const facts = parseTypeScriptSource(
    new URL('../src/relay-status-facts.ts', import.meta.url),
    readFileSync(new URL('../src/relay-status-facts.ts', import.meta.url), 'utf8'),
  );
  const readiness = functionCode(facts, 'readiness');
  assert.match(readiness, /micConnected: readers\.mic\.runtime\.connected\(\)/);
  assert.doesNotMatch(readiness, /micConnected: publisher\?\.readyState === WebSocket\.OPEN/);
  assert.match(variableInitializerCode(server, 'relayStatusFacts'), /runtime: micRuntime/);
  assert.match(functionCode(server, 'readinessPayload'), /relayStatusFacts\.readiness\(nowMs\)/);
});
