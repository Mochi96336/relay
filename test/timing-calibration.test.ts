import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { analyzeTimingCalibration } from '../src/timing-calibration.js';
import { laggedBeatPair, laggedPair, pulseTrain, toInt16 } from './helpers/harness.js';
import {
  sameBpmDifferentMusicPair,
  sameEnvelopeDifferentSpectrumPair,
  singleBandBeatPair,
} from './helpers/music-calibration.js';

const RATE = 48_000;

function int16View(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

describe('analyzeTimingCalibration', () => {
  for (const lagMs of [0, 120, 340, 900, -180]) {
    test(`recovers a ${lagMs} ms microphone lag`, () => {
      const { mic, backing } = laggedPair(6, RATE, lagMs);
      const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE);

      assert.ok(
        Math.abs(result.micLagMs - lagMs) <= 15,
        `expected ~${lagMs} ms, got ${result.micLagMs} ms (confidence ${result.confidence.toFixed(2)})`,
      );
      assert.ok(result.confidence > 0.2, `confidence too low: ${result.confidence}`);
      assert.equal(result.segmentLagsMs.length, 5);
    });
  }

  test('rejects a capture shorter than the required six seconds', () => {
    const { mic, backing } = laggedPair(3, RATE, 100);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE),
      /six seconds/,
    );
  });

  test('rejects a silent desktop source', () => {
    const { mic } = laggedPair(6, RATE, 100);
    const silence = Buffer.alloc(RATE * 6 * 2);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(silence), RATE),
      /too quiet/,
    );
  });

  test('rejects a microphone that never heard the phone speaker', () => {
    const { backing } = laggedPair(6, RATE, 100);
    const silence = Buffer.alloc(RATE * 6 * 2);
    assert.throws(
      () => analyzeTimingCalibration(int16View(silence), int16View(backing), RATE),
      /too quiet/,
    );
  });

  test('a true match agrees across every window', () => {
    const { mic, backing } = laggedPair(6, RATE, 340);
    const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE);

    const spread = Math.max(...result.segmentLagsMs) - Math.min(...result.segmentLagsMs);
    assert.equal(spread, 0, `windows disagreed: ${result.segmentLagsMs.join('/')}`);
    assert.ok(result.confidence > 0.9, `confidence ${result.confidence}`);
    assert.ok(Math.min(...result.segmentCorrelations) > 0.9);
  });

  // RED: the current RMS envelope accepts unrelated material often enough to
  // return a plausible confidence. The new content matcher must reject it before
  // the server's unchanged provisional-confidence path ever sees a result.
  test('rejects unrelated audio instead of returning a low-confidence guess', () => {
    const backing = toInt16(pulseTrain(RATE * 6, RATE, 3), 0.9);
    let rejected = 0;

    for (const seed of [99, 123, 4242, 777, 31337]) {
      const mic = toInt16(pulseTrain(RATE * 6, RATE, seed), 0.5);
      try {
        analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
      } catch {
        rejected += 1;
      }
    }

    assert.equal(rejected, 5, 'every unrelated fixture must be rejected outright');
  });

  // RED: both sides have the same RMS event envelope. Only the frequency order
  // differs, which the current estimator cannot observe at all.
  test('rejects the same loudness envelope with the wrong spectral sequence', () => {
    const { mic, backing } = sameEnvelopeDifferentSpectrumPair(6, RATE);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
    );
  });

  // RED: same tempo must not be mistaken for same content.
  test('rejects a different song at the same 120 BPM', () => {
    const { mic, backing } = sameBpmDifferentMusicPair(6, RATE);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
    );
  });

  // Existing beat-alias regression remains until the ambiguity model replaces
  // the near-zero preference in a later commit.
  for (const [lagMs, periodMs] of [[180, 500], [-220, 480], [150, 650]] as const) {
    test(`prefers a ${lagMs} ms lag over its ${periodMs} ms beat-period alias`, () => {
      const { mic, backing } = laggedBeatPair(6, RATE, lagMs, periodMs);
      const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE);

      assert.ok(
        Math.abs(result.micLagMs - lagMs) <= 25,
        `expected ~${lagMs} ms, got ${result.micLagMs} ms (a beat-period alias)`,
      );
    });
  }

  // RED for the final policy: truly single-band periodic content does not carry
  // enough evidence to choose one alias just because it is near zero.
  test('rejects a single-band equal-strength beat alias', () => {
    const { mic, backing } = singleBandBeatPair(6, RATE, 180, 500);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
    );
  });

  for (const lagMs of [-1790, 1600]) {
    test(`still recovers a genuine ${lagMs} ms lag, well outside the preferred range`, () => {
      const { mic, backing } = laggedPair(6, RATE, lagMs);
      const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);

      assert.ok(
        Math.abs(result.micLagMs - lagMs) <= 25,
        `expected ~${lagMs} ms, got ${result.micLagMs} ms `
        + `(confidence ${result.confidence.toFixed(2)}) - the near-zero preference overruled a true match`,
      );
    });
  }

  test('rejects an invalid sample rate', () => {
    const { mic, backing } = laggedPair(6, RATE, 0);
    assert.throws(() => analyzeTimingCalibration(int16View(mic), int16View(backing), 0), /sample rate/);
  });
});
