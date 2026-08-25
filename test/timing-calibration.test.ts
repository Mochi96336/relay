import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { analyzeTimingCalibration } from '../src/timing-calibration.js';
import { laggedPair, pulseTrain, toInt16 } from './helpers/harness.js';
import {
  laggedMultibandMusicPair,
  sameBpmDifferentMusicPair,
  sameEnvelopeDifferentSpectrumPair,
  singleBandBeatPair,
} from './helpers/music-calibration.js';

const RATE = 48_000;

function int16View(buffer: Buffer) {
  return new Int16Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 2);
}

/** A close phone singer: voiced harmonics with syllable attacks locked to 120 BPM. */
function addVoiceDominantOnBeatSinger(mic: Buffer, gain: number) {
  const output = Buffer.from(mic);
  const samples = output.byteLength / 2;
  for (let i = 0; i < samples; i += 1) {
    const seconds = i / RATE;
    const fundamental = 205 + 35 * Math.sin(2 * Math.PI * 0.28 * seconds);
    let voiced = 0;
    for (let harmonic = 1; harmonic <= 5; harmonic += 1) {
      voiced += Math.sin(2 * Math.PI * fundamental * harmonic * seconds) / (harmonic * 1.35);
    }
    const beatPhase = seconds % 0.5;
    const syllable = 0.16 + 0.84 * Math.exp(-beatPhase * 11);
    const base = output.readInt16LE(i * 2) / 32768;
    const mixed = Math.max(-1, Math.min(1, base + voiced * syllable * gain));
    output.writeInt16LE(Math.round(mixed < 0 ? mixed * 32768 : mixed * 32767), i * 2);
  }
  return output;
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
      assert.ok(result.diagnostics.activeBands.length >= 3);
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

  test('rejects a microphone that contains no matching playback content', () => {
    const { backing } = laggedPair(6, RATE, 100);
    const silence = Buffer.alloc(RATE * 6 * 2);
    assert.throws(
      () => analyzeTimingCalibration(int16View(silence), int16View(backing), RATE),
      /weak|does not match|support|repetitive/i,
    );
  });

  test('a true match agrees across every window', () => {
    const { mic, backing } = laggedPair(6, RATE, 340);
    const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE);
    const spread = Math.max(...result.segmentLagsMs) - Math.min(...result.segmentLagsMs);
    assert.equal(spread, 0, `windows disagreed: ${result.segmentLagsMs.join('/')}`);
    assert.ok(result.confidence > 0.9, `confidence ${result.confidence}`);
    assert.ok(Math.min(...result.segmentCorrelations) > 0.5);
    assert.ok((result.diagnostics.peakMargin ?? 1) >= 0.05);
  });

  test('rejects unrelated audio instead of returning a low-confidence guess', () => {
    const backing = toInt16(pulseTrain(RATE * 6, RATE, 3), 0.9);
    for (const seed of [99, 123, 4242, 777, 31337]) {
      const mic = toInt16(pulseTrain(RATE * 6, RATE, seed), 0.5);
      assert.throws(
        () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
        /weak|does not match|repetitive|support/i,
      );
    }
  });

  test('rejects the same loudness envelope with the wrong spectral sequence', () => {
    const { mic, backing } = sameEnvelopeDifferentSpectrumPair(6, RATE);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
      /repetitive|does not match|support/i,
    );
  });

  test('rejects a different song at the same 120 BPM', () => {
    const { mic, backing } = sameBpmDifferentMusicPair(6, RATE);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
      /repetitive|does not match|support/i,
    );
  });

  for (const lagMs of [0, 120, 340, 900, -180]) {
    test(`multiband music recovers a ${lagMs} ms lag without a physical-lag prior`, () => {
      const { mic, backing } = laggedMultibandMusicPair(6, RATE, lagMs);
      const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
      assert.ok(
        Math.abs(result.micLagMs - lagMs) <= 25,
        `expected ~${lagMs} ms, got ${result.micLagMs} ms`,
      );
      assert.ok(result.confidence >= 0.55, `confidence ${result.confidence}`);
      assert.ok((result.diagnostics.peakMargin ?? 1) >= 0.05);
    });
  }

  test('survives phone-speaker frequency coloration', () => {
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 285, {
      micBandGains: [0.15, 0.35, 0.70, 1.00, 0.80, 0.35, 0.10],
    });
    const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
    assert.ok(Math.abs(result.micLagMs - 285) <= 25, `got ${result.micLagMs} ms`);
    assert.ok(result.confidence >= 0.55, `confidence ${result.confidence}`);
  });

  test('survives missing high-frequency microphone bands', () => {
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 285, {
      micBandGains: [1, 1, 1, 1, 1, 0, 0],
    });
    const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
    assert.ok(Math.abs(result.micLagMs - 285) <= 25, `got ${result.micLagMs} ms`);
  });

  test('survives moderate singer interference', () => {
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 285, { singerGain: 0.16 });
    const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
    assert.ok(Math.abs(result.micLagMs - 285) <= 25, `got ${result.micLagMs} ms`);
    assert.ok(result.confidence >= 0.55, `confidence ${result.confidence}`);
  });

  for (const singerGain of [0.25, 0.45, 0.7]) {
    test(`voice-dominant on-beat singer ${singerGain}x is accurate or safely rejected`, () => {
      const { mic, backing } = laggedMultibandMusicPair(6, RATE, 285);
      const interferedMic = addVoiceDominantOnBeatSinger(mic, singerGain);
      let result;
      try {
        result = analyzeTimingCalibration(int16View(interferedMic), int16View(backing), RATE, 2_500);
      } catch {
        // Rejection is the safe runtime outcome: rejected evidence cannot become
        // either half of a drift-confirmation pair.
        return;
      }
      assert.ok(
        Math.abs(result.micLagMs - 285) <= 25,
        `voice-dominant interference produced a wrong authoritative lag ${result.micLagMs} ms`,
      );
    });
  }

  test('survives slow AGC changes over the six-second window', () => {
    const { mic, backing } = laggedMultibandMusicPair(6, RATE, 285, { agc: true });
    const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
    assert.ok(Math.abs(result.micLagMs - 285) <= 25, `got ${result.micLagMs} ms`);
  });

  test('rejects an equal-strength single-band beat alias', () => {
    const { mic, backing } = singleBandBeatPair(6, RATE, 180, 500);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
      /spectral activity|repetitive|support/i,
    );
  });

  for (const lagMs of [-1790, 1600]) {
    test(`still recovers a genuine ${lagMs} ms lag`, () => {
      const { mic, backing } = laggedPair(6, RATE, lagMs);
      const result = analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500);
      assert.ok(
        Math.abs(result.micLagMs - lagMs) <= 25,
        `expected ~${lagMs} ms, got ${result.micLagMs} ms `
        + `(confidence ${result.confidence.toFixed(2)})`,
      );
    });
  }

  test('ambiguous content never produces a provisional-eligible confidence', () => {
    const { mic, backing } = sameEnvelopeDifferentSpectrumPair(6, RATE);
    assert.throws(
      () => analyzeTimingCalibration(int16View(mic), int16View(backing), RATE, 2_500),
      /repetitive|does not match|support/i,
      'ambiguous content must be rejected before confidence can reach the server',
    );
  });

  test('rejects an invalid sample rate', () => {
    const { mic, backing } = laggedPair(6, RATE, 0);
    assert.throws(() => analyzeTimingCalibration(int16View(mic), int16View(backing), 0), /sample rate/);
  });
});
