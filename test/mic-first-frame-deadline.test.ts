import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const micRuntime = readFileSync(new URL('../src/mic-runtime.ts', import.meta.url), 'utf8');

test('server bounds connected Mic startup through the MicRuntime readiness owner', () => {
  assert.match(server, /RELAY_MIC_FIRST_FRAME_TIMEOUT_MS', 3_000/);
  assert.match(
    server,
    /new MicRuntime\(\{[\s\S]{0,300}firstFrameTimeoutMs:\s*MIC_FIRST_FRAME_TIMEOUT_MS/,
    'the validated server deadline must be injected into the transport-state owner',
  );
  assert.match(micRuntime, /private firstFrameWaitStartedAt = -Infinity/);
  assert.match(
    micRuntime,
    /resetFlowEvidence\(nowMs: number\)[\s\S]{0,400}this\.firstFrameWaitStartedAt = this\.currentMediaOwnerId === null \? -Infinity : nowMs/,
  );
  assert.match(
    micRuntime,
    /startupTimedOut\(nowMs: number\)[\s\S]{0,400}this\.connected\(\)[\s\S]{0,200}!this\.flowObserved\(\)[\s\S]{0,300}this\.options\.firstFrameTimeoutMs/,
  );
  assert.match(
    server,
    /function micStartupTimedOut\(nowMs = performance\.now\(\)\)[\s\S]{0,150}micRuntime\.startupTimedOut\(nowMs\)/,
    'server readiness must consume the runtime deadline result instead of duplicating its timer state',
  );
  assert.match(server, /micStartupTimedOut: micStartupTimedOut\(nowMs\)/);
});
