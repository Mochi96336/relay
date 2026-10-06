import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  classMethodCode,
  functionCode,
  parseTypeScriptSource,
  sourceCode,
  variableInitializerCode,
} from './support/source-contract.js';

const server = parseTypeScriptSource(
  new URL('../src/server.ts', import.meta.url),
  readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8'),
);
const micRuntime = parseTypeScriptSource(
  new URL('../src/mic-runtime.ts', import.meta.url),
  readFileSync(new URL('../src/mic-runtime.ts', import.meta.url), 'utf8'),
);
const statusFacts = parseTypeScriptSource(
  new URL('../src/relay-status-facts.ts', import.meta.url),
  readFileSync(new URL('../src/relay-status-facts.ts', import.meta.url), 'utf8'),
);
const serverCode = sourceCode(server);
const micRuntimeCode = sourceCode(micRuntime);

test('server bounds connected Mic startup through the MicRuntime readiness owner', () => {
  assert.ok(serverCode.includes('const MIC_FIRST_FRAME_TIMEOUT_MS = relayConfig.micFirstFrameTimeoutMs;'));

  const construction = variableInitializerCode(server, 'micRuntime');
  assert.ok(construction.includes('new MicRuntime({'));
  assert.ok(
    construction.includes('firstFrameTimeoutMs: MIC_FIRST_FRAME_TIMEOUT_MS'),
    'the normalized server deadline must be injected into the transport-state owner',
  );

  assert.ok(micRuntimeCode.includes('private firstFrameWaitStartedAt = -Infinity'));

  const resetFlowEvidence = classMethodCode(micRuntime, 'MicRuntime', 'resetFlowEvidence');
  assert.ok(resetFlowEvidence.includes(
    'this.firstFrameWaitStartedAt = this.currentMediaOwnerId === null ? -Infinity : nowMs',
  ));

  const startupTimedOut = classMethodCode(micRuntime, 'MicRuntime', 'startupTimedOut');
  for (const expected of [
    'this.connected()',
    '!this.flowObserved()',
    'Number.isFinite(this.firstFrameWaitStartedAt)',
    'nowMs - this.firstFrameWaitStartedAt >= this.options.firstFrameTimeoutMs',
  ]) {
    assert.ok(startupTimedOut.includes(expected), `MicRuntime startup deadline must retain ${expected}`);
  }

  const readiness = functionCode(statusFacts, 'readiness');
  assert.match(readiness, /micStartupTimedOut: readers\.mic\.runtime\.startupTimedOut\(nowMs\)/,
    'readiness must consume the live runtime deadline instead of duplicating its timer state');
  assert.match(readiness, /micFlowObserved: readers\.mic\.runtime\.flowObserved\(\)/);
  assert.match(variableInitializerCode(server, 'relayStatusFacts'),
    /mic:\s*\{\s*runtime: micRuntime,/,
    'production collection must use the canonical MicRuntime, not an independent deadline owner');
  assert.match(functionCode(server, 'readinessPayload'),
    /return relayStatusFacts\.readiness\(nowMs\)/);
  assert.doesNotMatch(sourceCode(statusFacts), /firstFrameWaitStartedAt|firstFrameTimeoutMs/,
    'the collector must not become a second startup-deadline authority');
});
