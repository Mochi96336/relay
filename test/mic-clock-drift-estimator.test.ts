import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MicClockDriftEstimator } from '../src/mic-clock-drift-estimator.js';

const RATE = 48_000;
const CHUNK = 960;

/**
 * A capture clock `ppm` slow (positive) or fast (negative) against the mix
 * clock, with every packet delayed by `jitter(n)` ms of queueing on top of a
 * fixed 30 ms path.
 */
function feed(
  estimator: MicClockDriftEstimator,
  { ppm, seconds, jitter }: { ppm: number; seconds: number; jitter: (n: number) => number },
) {
  const packets = Math.round((seconds * RATE) / CHUNK);
  for (let n = 0; n < packets; n += 1) {
    const sourceEnd = (n + 1) * CHUNK;
    // Real time at which the source clock finished this packet.
    const capturedAtMs = (sourceEnd / RATE) * 1000 * (1 + ppm / 1e6);
    estimator.observe(1, RATE, sourceEnd, capturedAtMs + 30 + jitter(n));
  }
}

let seed = 7;
function noise() {
  seed = (seed * 1_103_515_245 + 12_345) >>> 0;
  return (seed >>> 16) / 65_536;
}

describe('MicClockDriftEstimator', () => {
  for (const ppm of [80, -60, 0]) {
    it(`recovers a ${ppm} ppm capture clock through heavy queueing jitter`, () => {
      const estimator = new MicClockDriftEstimator();
      // Up to 120 ms of one-sided queueing delay per packet: a naive fit of
      // arrival times would be dominated by it.
      feed(estimator, { ppm, seconds: 120, jitter: () => noise() * 120 });
      const estimate = estimator.estimate();
      assert.ok(estimate);
      assert.ok(Math.abs(estimate.ppm - ppm) < 15, `estimated ${estimate.ppm} for ${ppm}`);
      assert.ok(estimate.windows >= 20);
    });
  }

  it('ignores a slow start-up and one disturbed window instead of tilting the fit', () => {
    const estimator = new MicClockDriftEstimator();
    // 400 ms of start-up delay in the first seconds, then a 300 ms network
    // hiccup that holds every packet of one later window back.
    feed(estimator, {
      ppm: 0,
      seconds: 120,
      jitter: (n) => {
        const atMs = n * 20;
        if (atMs < 4_000) return 400 - atMs / 10;
        if (atMs >= 60_000 && atMs < 66_000) return 300;
        return noise() * 20;
      },
    });
    const estimate = estimator.estimate();
    assert.ok(estimate);
    assert.ok(Math.abs(estimate.ppm) < 15, `a stable clock read as ${estimate.ppm} ppm`);
  });

  for (const ppm of [0, 60]) {
    it(`reads a one-chunk latency step as a step, not as drift (${ppm} ppm)`, () => {
      const estimator = new MicClockDriftEstimator();
      // Base latency jumps 20 ms at 80 s and stays there: a path change.
      feed(estimator, {
        ppm,
        seconds: 120,
        jitter: (n) => (n * 20 >= 80_000 ? 20 : 0) + noise() * 3,
      });
      const estimate = estimator.estimate();
      assert.ok(estimate);
      assert.ok(Math.abs(estimate.ppm - ppm) < 15, `estimated ${estimate.ppm} for ${ppm}`);
    });
  }

  it('waits for enough windows before estimating', () => {
    const estimator = new MicClockDriftEstimator();
    feed(estimator, { ppm: 50, seconds: 20, jitter: () => 0 });
    assert.equal(estimator.estimate(), null);
  });

  it('restarts from nothing for a new capture generation', () => {
    const estimator = new MicClockDriftEstimator();
    feed(estimator, { ppm: 50, seconds: 90, jitter: () => 0 });
    assert.ok(estimator.estimate());
    estimator.observe(2, RATE, CHUNK, 999_999);
    assert.equal(estimator.estimate(), null);
  });
});
