import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  functionCode,
  parseTypeScriptSource,
  sourceCode,
} from './support/source-contract.js';

test('capture gaps are reported as exact sample deltas without changing the padded timeline', () => {
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

  assert.match(workletCode, /samples: unreported \* RENDER_QUANTUM/);
  assert.match(workletCode, /this\.writeSilence\(RENDER_QUANTUM\)/);
  assert.match(workletCode, /this\.reportInputGap\(true\)/);
  assert.match(appCode, /captureInputGapSamples \+= samples/);
  assert.match(appCode, /type: 'audio-uplink-health'/);
  assert.match(appCode, /transport: audioTransport\.stats\(\)/);
});

test('readiness samples media connectivity rather than only the control websocket', () => {
  const server = parseTypeScriptSource(
    new URL('../src/server.ts', import.meta.url),
    readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
  );
  const readiness = functionCode(server, 'readinessPayload');
  assert.match(readiness, /micConnected: micMediaConnected\(\)/);
  assert.doesNotMatch(readiness, /micConnected: publisher\?\.readyState === WebSocket\.OPEN/);
});
