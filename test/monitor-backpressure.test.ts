import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  monitorBacklogBudgetBytes,
  monitorFrameWouldExceedBacklog,
} from '../src/monitor-backpressure.js';

const RATE = 48_000;
const FRAME_BYTES = RATE * 0.02 * Int16Array.BYTES_PER_ELEMENT;

test('200 ms monitor backlog budget is 19.2 kB at 48 kHz mono int16', () => {
  assert.equal(monitorBacklogBudgetBytes(RATE, 200), 19_200);
});

test('monitor drops the frame that would push server-side stale PCM past the budget', () => {
  const budget = monitorBacklogBudgetBytes(RATE, 200);
  assert.equal(FRAME_BYTES, 1_920);
  assert.equal(monitorFrameWouldExceedBacklog(budget - FRAME_BYTES, FRAME_BYTES, budget), false);
  assert.equal(monitorFrameWouldExceedBacklog(budget, FRAME_BYTES, budget), true);
});

test('monitor backlog budget stays server-configured while socket fanout owns enforcement', async () => {
  const serverSource = await readFile(new URL('../src/server.ts', import.meta.url), 'utf8');
  const socketSource = await readFile(new URL('../src/relay-socket-server.ts', import.meta.url), 'utf8');

  assert.match(serverSource, /monitorBacklogBudgetBytes\(MIX_SAMPLE_RATE, MONITOR_BACKLOG_MS\)/);
  assert.match(serverSource, /createMonitorSocketTransport\(wss, \{[\s\S]*backlogBytes: MONITOR_BACKLOG_BYTES/);
  assert.doesNotMatch(serverSource, /monitorFrameWouldExceedBacklog|socket\.bufferedAmount/);

  assert.match(socketSource, /monitorFrameWouldExceedBacklog\([\s\S]*socket\.bufferedAmount[\s\S]*outbound\.byteLength[\s\S]*options\.backlogBytes/);
  assert.doesNotMatch(socketSource, /512\s*\*\s*1024/);
});
