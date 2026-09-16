import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  realtimeFrameWouldExceedBacklog,
  realtimePcmBacklogBudgetBytes,
} from '../src/realtime-uplink-backpressure.js';

test('realtime PCM backlog budget is a duration at the actual sample rate', () => {
  assert.equal(realtimePcmBacklogBudgetBytes(48_000, 200), 19_200);
  assert.equal(realtimePcmBacklogBudgetBytes(44_100, 200), 17_640);
  assert.equal(realtimePcmBacklogBudgetBytes(8_000, 200), 3_200);
});

test('one deliberately large frame remains sendable while the normal budget stays time based', () => {
  assert.equal(realtimePcmBacklogBudgetBytes(48_000, 200, 1_936), 19_200);
  assert.equal(realtimePcmBacklogBudgetBytes(48_000, 20, 4_816), 4_816);
});

test('realtime backlog rejects the frame that would cross the latency budget', () => {
  const budget = realtimePcmBacklogBudgetBytes(48_000, 200);
  assert.equal(realtimeFrameWouldExceedBacklog(17_264, 1_936, budget), false);
  assert.equal(realtimeFrameWouldExceedBacklog(17_265, 1_936, budget), true);
});

test('invalid realtime backlog inputs fail closed', () => {
  assert.throws(() => realtimePcmBacklogBudgetBytes(0, 200), /sample rate must be positive/);
  assert.throws(() => realtimePcmBacklogBudgetBytes(48_000, 0), /duration must be positive/);
  assert.throws(() => realtimePcmBacklogBudgetBytes(48_000, 200, -1), /minimum frame bytes/);
});

test('robot backing clamps the legacy byte ceiling to a sample-rate-aware realtime budget', async () => {
  const source = await readFile(new URL('../src/backing-stdin.ts', import.meta.url), 'utf8');

  assert.match(source, /const REALTIME_BACKLOG_MS = 200/);
  assert.match(source, /const FRAMED_BYTES = FRAME_HEADER_BYTES \+ FRAME_BYTES/);
  assert.match(
    source,
    /realtimePcmBacklogBudgetBytes\(\s*SAMPLE_RATE,\s*REALTIME_BACKLOG_MS,\s*FRAMED_BYTES,/,
  );
  assert.match(
    source,
    /Math\.max\(\s*FRAMED_BYTES,\s*Math\.min\(CONFIGURED_MAX_BUFFERED_BYTES, REALTIME_BACKLOG_BYTES\),/,
  );
  assert.match(
    source,
    /const frame = encodePcmFrame\([\s\S]*realtimeFrameWouldExceedBacklog\(\s*socket\.bufferedAmount,\s*frame\.byteLength,\s*MAX_BUFFERED_BYTES,[\s\S]*socket\.send\(frame\)/,
  );
  assert.doesNotMatch(source, /socket\.bufferedAmount >= MAX_BUFFERED_BYTES/);
});
