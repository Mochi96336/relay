import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');

test('server bounds connected Mic startup and feeds the canonical readiness snapshot', () => {
  assert.match(server, /RELAY_MIC_FIRST_FRAME_TIMEOUT_MS', 3_000/);
  assert.match(server, /let micFirstFrameWaitStartedAt = -Infinity/);
  assert.match(
    server,
    /function resetMicFlowEvidence\(nowMs = performance\.now\(\)\)[\s\S]{0,300}micFirstFrameWaitStartedAt = micMediaOwnerId === null \? -Infinity : nowMs/
  );
  assert.match(
    server,
    /function micStartupTimedOut\(nowMs = performance\.now\(\)\)[\s\S]{0,400}micMediaConnected\(\)[\s\S]{0,200}!micFlowObserved\(\)[\s\S]{0,200}MIC_FIRST_FRAME_TIMEOUT_MS/
  );
  assert.match(server, /micStartupTimedOut: micStartupTimedOut\(nowMs\)/);
});
