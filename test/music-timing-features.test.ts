import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { extractMusicTimingFeatures } from '../src/music-timing-features.js';

const RATE = 48_000;

function transient(frequency: number) {
  const samples = new Int16Array(RATE * 2);
  const start = Math.round(RATE * 0.25);
  const length = Math.round(RATE * 0.18);
  for (let i = 0; i < length; i += 1) {
    const seconds = i / RATE;
    samples[start + i] = Math.round(
      Math.sin(2 * Math.PI * frequency * seconds)
      * 0.8
      * Math.exp(-seconds * 25)
      * 32767,
    );
  }
  return samples;
}

describe('extractMusicTimingFeatures', () => {
  for (const [frequency, expectedBand] of [
    [200, 0],
    [750, 2],
    [3_000, 4],
    [7_000, 6],
  ] as const) {
    test(`${frequency} Hz transient is strongest in B${expectedBand}`, () => {
      const features = extractMusicTimingFeatures(transient(frequency), RATE);
      let strongest = 0;
      for (let band = 1; band < features.bandCount; band += 1) {
        if (features.bandActivity[band] > features.bandActivity[strongest]) strongest = band;
      }

      assert.equal(strongest, expectedBand);
      assert.equal(features.bandCount, 7);
      assert.equal(features.values.length, features.frameCount * 14);
      assert.equal(features.hopSamples, 240);
      assert.equal(features.hopMs, 5);
    });
  }
});
