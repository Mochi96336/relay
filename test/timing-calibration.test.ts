import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { analyzeTimingCalibration } from '../src/timing-calibration.js';
import { laggedPair, pulseTrain, toInt16 } from './helpers/harness.js';

const RATE = 48_000;

function int16View(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

describe('analyzeTimingCalibration', () => {
  for (const lagMs of [0, 120, 340, 900, -180]) {
    test(`recovers a ${lagMs} ms microphone lag`, () => {
      const { mic, backing } = laggedPair(6, RATE, lagMs);
      const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE);

      // The envelope resolution is 5 ms per frame, so exact equality is not the
      // contract; being within a couple of frames is.
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

  // KNOWN GAP, documented rather than asserted away: MIN_GLOBAL_CORRELATION 0.12
  // and the 140 ms window-spread limit are permissive enough that unrelated
  // audio is usually accepted, reporting confidence around 0.4-0.6 and lags of
  // several hundred ms. A bogus multi-second lag is not harmless - it puts the
  // mixer's read head past the end of the microphone history immediately.
  // Tightening the thresholds needs real device captures to calibrate against,
  // so this test pins the discrimination margin that any change must preserve.
  test('scores unrelated audio below a true match', () => {
    const backing = toInt16(pulseTrain(RATE * 6, RATE, 3), 0.9);
    const accepted: number[] = [];

    for (const seed of [99, 123, 4242, 777, 31337]) {
      const mic = toInt16(pulseTrain(RATE * 6, RATE, seed), 0.5);
      try {
        accepted.push(analyzeTimingCalibration(int16View(mic), int16View(backing), RATE).confidence);
      } catch {
        // Rejected outright, which is the outcome we would prefer for all of them.
      }
    }

    const { mic, backing: matchedBacking } = laggedPair(6, RATE, 340);
    const matched = analyzeTimingCalibration(int16View(mic), int16View(matchedBacking), RATE);

    for (const confidence of accepted) {
      assert.ok(
        matched.confidence - confidence > 0.3,
        `unrelated audio scored ${confidence.toFixed(2)} against a true match at ${matched.confidence.toFixed(2)}`,
      );
    }
  });

  test('rejects an invalid sample rate', () => {
    const { mic, backing } = laggedPair(6, RATE, 0);
    assert.throws(() => analyzeTimingCalibration(int16View(mic), int16View(backing), 0), /sample rate/);
  });
});
