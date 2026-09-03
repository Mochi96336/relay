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

  const serverDeadline = functionCode(server, 'micStartupTimedOut');
  assert.ok(
    serverDeadline.includes('return micRuntime.startupTimedOut(nowMs)'),
    'server readiness must consume the runtime deadline result instead of duplicating its timer state',
  );
  assert.ok(serverCode.includes('micStartupTimedOut: micStartupTimedOut(nowMs)'));
});
