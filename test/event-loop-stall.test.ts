import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { EVENT_LOOP_STALL_MS, eventLoopStall, watchEventLoopStalls } from '../src/event-loop-stall.js';

function histogram(maxMs: number, p99Ms: number) {
  return { max: maxMs * 1e6, percentile: () => p99Ms * 1e6 };
}

test('only a window that held a real stall is reported', () => {
  assert.equal(eventLoopStall(histogram(40, 25), 1_000), null);
  assert.equal(eventLoopStall(histogram(EVENT_LOOP_STALL_MS - 1, 30), 1_000), null);
  assert.deepEqual(eventLoopStall(histogram(352.4, 351.9), 1_000), { maxDelayMs: 352, p99DelayMs: 352, windowMs: 1_000 });
});

test('an empty histogram is not a stall', () => {
  assert.equal(eventLoopStall({ max: Number.NaN, percentile: () => 0 }, 1_000), null);
});

test('a blocked loop is logged by the watcher', async () => {
  const records: unknown[] = [];
  const stop = watchEventLoopStalls((record) => records.push(record), { windowMs: 100, thresholdMs: 80 });
  try {
    await sleep(30);
    const until = Date.now() + 150;
    while (Date.now() < until) { /* hold the event loop */ }
    await sleep(250);
  } finally {
    stop();
  }
  assert.ok(records.length >= 1, 'the 150 ms block was seen');
});
