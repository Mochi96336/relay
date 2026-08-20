import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test, { describe } from 'node:test';

import { analyzeTimingCalibrationInWorker } from '../src/timing-calibration-worker-client.js';
import { laggedPair } from './helpers/harness.js';

const RATE = 48_000;

function int16View(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

describe('timing calibration worker', () => {
  test('finds the lag without blocking main-thread timers', async () => {
    const { mic, backing } = laggedPair(6, RATE, 340);
    const analysis = analyzeTimingCalibrationInWorker(
      int16View(mic),
      int16View(backing),
      RATE,
      2_500,
    );

    const timerStarted = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const timerDelay = performance.now() - timerStarted;
    assert.ok(timerDelay < 150, `main-thread timer was delayed ${timerDelay.toFixed(1)} ms`);

    const result = await analysis;
    assert.ok(Math.abs(result.micLagMs - 340) <= 15, `got ${result.micLagMs} ms`);
  });

  test('returns analyzer errors through the promise boundary', async () => {
    const silence = new Int16Array(RATE * 6);
    await assert.rejects(
      analyzeTimingCalibrationInWorker(silence, silence, RATE),
      /Desktop source is too quiet/,
    );
  });

  test('terminates work that its collection cancelled', async () => {
    const { mic, backing } = laggedPair(6, RATE, 340);
    const controller = new AbortController();
    const analysis = analyzeTimingCalibrationInWorker(
      int16View(mic),
      int16View(backing),
      RATE,
      2_500,
      controller.signal,
    );

    controller.abort();
    await assert.rejects(analysis, /was cancelled/);
  });
});
