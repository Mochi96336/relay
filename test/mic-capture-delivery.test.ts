import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MicCaptureDeliveryMonitor } from '../src/mic-capture-delivery.js';

const RATE = 48_000;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/**
 * A phone reporting uplink health once a second. `lostMsBy(wallMs)` is the
 * real time its capture has lost so far; `delayMs(index)` is how late each
 * report reaches the server.
 */
function run(
  seconds: number,
  lostMsBy: (wallMs: number) => number,
  delayMs: (index: number) => number,
  generation = 7,
) {
  const monitor = new MicCaptureDeliveryMonitor();
  for (let index = 0; index < seconds; index += 1) {
    const wallMs = 1_000 + index * 1_000;
    const capturedSamples = Math.round(((wallMs - lostMsBy(wallMs)) * RATE) / 1000);
    monitor.observe({ generation, capturedSamples, sampleRate: RATE, atMs: wallMs + 40 + delayMs(index) });
  }
  return monitor;
}

describe('Mic capture delivery', () => {
  test('a capture keeping real time shows no loss through arrival jitter', () => {
    const jitter = random(3);
    const status = run(120, () => 0, () => jitter() * 80).status();
    assert.ok(status);
    assert.ok(status.lossMs < 60, `jitter alone read as ${status.lossMs} ms of loss`);
    assert.ok(status.ratio !== null && Math.abs(status.ratio - 1) < 0.005, `ratio ${status.ratio}`);
  });

  test('a capture losing 220 ms every 7 s is measured close to what it lost', () => {
    // The 2026-10-03 pattern: about 3% of real time, in bursts.
    const lostMsBy = (wallMs: number) => Math.floor(wallMs / 7_000) * 220;
    const jitter = random(5);
    const status = run(120, lostMsBy, () => jitter() * 60).status();
    assert.ok(status);
    const lastReportMs = 1_000 + 119 * 1_000;
    // The envelope trails by up to its window: never more than the loss so far,
    // never less than the loss of five reports ago.
    assert.ok(status.lossMs <= lostMsBy(lastReportMs) + 60, `measured ${status.lossMs} ms`);
    assert.ok(status.lossMs >= lostMsBy(lastReportMs - 5_000) - 60, `measured ${status.lossMs} ms`);
    assert.ok(status.ratio !== null && status.ratio < 0.975 && status.ratio > 0.96, `ratio ${status.ratio}`);
  });

  test('reports delayed in a burst do not read as capture loss', () => {
    // Three reports in a row stuck behind a busy control path.
    const delayMs = (index: number) => (index >= 60 && index < 63 ? 800 : 0);
    const status = run(66, () => 0, delayMs).status();
    assert.ok(status);
    assert.equal(status.lossMs, 0);
  });

  test('nothing is judged before the envelope has filled', () => {
    const lostMsBy = (wallMs: number) => (wallMs > 2_000 ? 500 : 0);
    assert.equal(run(4, lostMsBy, () => 0).status()?.lossMs, 0);
    assert.equal(run(4, lostMsBy, () => 0).status()?.ratio, null);
    assert.equal(new MicCaptureDeliveryMonitor().status(), null);
  });

  test('a new capture generation starts from nothing', () => {
    const monitor = new MicCaptureDeliveryMonitor();
    for (let index = 0; index < 20; index += 1) {
      const wallMs = 1_000 + index * 1_000;
      const lost = index > 10 ? 1_000 : 0;
      monitor.observe({
        generation: 7,
        capturedSamples: Math.round(((wallMs - lost) * RATE) / 1000),
        sampleRate: RATE,
        atMs: wallMs,
      });
    }
    assert.ok(monitor.status()!.lossMs > 900);

    monitor.observe({ generation: 8, capturedSamples: RATE, sampleRate: RATE, atMs: 30_000 });
    assert.deepEqual(monitor.status(), { generation: 8, lossMs: 0, ratio: null, windowMs: null });
  });

  test('a report counting backwards is ignored rather than read as time gained', () => {
    const monitor = run(20, (wallMs) => (wallMs > 8_000 ? 400 : 0), () => 0);
    const before = monitor.status()!.lossMs;
    monitor.observe({ generation: 7, capturedSamples: 0, sampleRate: RATE, atMs: 21_500 });
    assert.equal(monitor.status()!.lossMs, before);
  });
});
