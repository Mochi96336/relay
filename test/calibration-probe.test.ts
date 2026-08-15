import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  generateProbeReference,
  locateProbe,
  PROBE_NOTES,
  PROBE_REFERENCE_MS,
} from '../src/calibration-probe.js';

const RATE = 48_000;

/** Deterministic PRNG so a failing assertion is reproducible. */
function lcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function toInt16(values: Float64Array) {
  const output = new Int16Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, values[i]));
    output[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return output;
}

/** White noise, standing in for room tone / vocal bleed the probe rides on top of. */
function noise(samples: number, amplitude: number, seed: number) {
  const random = lcg(seed);
  const output = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) output[i] = (random() - 0.5) * 2 * amplitude;
  return output;
}

describe('calibration-probe', () => {
  test('uses a restrained ascending success chime with irregular timing', () => {
    assert.ok(PROBE_NOTES.every((note) => note.gain <= 0.32), 'does not become a loud notification');
    assert.ok(
      PROBE_NOTES.every((note, index) => index === 0 || note.frequencyHz > PROBE_NOTES[index - 1].frequencyHz),
      'notes ascend',
    );
    const gaps = PROBE_NOTES.slice(1).map((note, index) => note.offsetMs - PROBE_NOTES[index].offsetMs);
    assert.notEqual(gaps[0], gaps[1], 'timing remains irregular for unambiguous correlation');
  });

  test('locates the reference at a known offset inside a noisy window', () => {
    const reference = generateProbeReference(RATE);
    const windowSamples = Math.round(RATE * 1.5);
    const trueOffsetMs = 400;
    const trueOffsetSamples = Math.round((RATE * trueOffsetMs) / 1000);

    const window = noise(windowSamples, 0.05, 7);
    for (let i = 0; i < reference.length; i += 1) {
      window[trueOffsetSamples + i] += reference[i] / 32768;
    }

    const result = locateProbe(toInt16(window), RATE);
    assert.ok(
      Math.abs(result.offsetSamples - trueOffsetSamples) <= Math.round((RATE * 10) / 1000),
      `expected ~${trueOffsetSamples} samples, got ${result.offsetSamples}`,
    );
    assert.ok(result.correlation > 0.5, `correlation too low: ${result.correlation}`);
  });

  test('scores low when the probe was never actually heard', () => {
    const windowSamples = Math.round(RATE * 1.5);
    const window = toInt16(noise(windowSamples, 0.05, 11));

    const result = locateProbe(window, RATE);
    assert.ok(result.correlation < 0.5, `expected a weak match, got ${result.correlation}`);
  });

  test('reference length matches its declared duration', () => {
    const reference = generateProbeReference(RATE);
    const expected = Math.round((RATE * PROBE_REFERENCE_MS) / 1000);
    assert.equal(reference.length, expected);
  });

  test('is quiet before the first click and silent well after the last one decays', () => {
    const reference = generateProbeReference(RATE);
    assert.equal(reference[0], 0, 'starts at the first click onset, not mid-tone');
    const tail = reference.subarray(reference.length - 20);
    assert.ok(tail.every((sample) => Math.abs(sample) < 50), 'fully decayed by the end of the window');
  });
});
