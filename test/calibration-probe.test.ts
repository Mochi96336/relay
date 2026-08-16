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

/**
 * Browser-side probe shape from public/app.js / public/source.js.
 *
 * The server reference is deliberately not byte-identical to WebAudio's ramp,
 * so this catches detector changes that only work against the synthetic server
 * waveform and fail against what a phone actually emits.
 */
function browserProbe(sampleRate: number) {
  const totalSamples = Math.round((sampleRate * PROBE_REFERENCE_MS) / 1000);
  const output = new Float64Array(totalSamples);
  const attackSeconds = 0.004;
  const noteSeconds = 0.105;

  for (const note of PROBE_NOTES) {
    const startSample = Math.round((sampleRate * note.offsetMs) / 1000);
    const noteSamples = Math.round(sampleRate * noteSeconds);
    for (let i = 0; i < noteSamples && startSample + i < output.length; i += 1) {
      const seconds = i / sampleRate;
      const gain = seconds <= attackSeconds
        ? 0.0001 * ((note.gain / 0.0001) ** (seconds / attackSeconds))
        : note.gain * ((0.0001 / note.gain) ** ((seconds - attackSeconds) / (noteSeconds - attackSeconds)));
      output[startSample + i] += Math.sin(2 * Math.PI * note.frequencyHz * seconds) * gain;
    }
  }

  return output;
}

/**
 * A deterministic, structured music-like bed rather than white noise.
 * Includes a harmonic close to E6 so the detector has to use the complete
 * frequency/timing signature instead of merely finding a quiet 470 ms patch.
 */
function musicBed(samples: number, amplitude: number) {
  const output = new Float64Array(samples);
  for (let i = 0; i < samples; i += 1) {
    const seconds = i / RATE;
    const carrier = (
      0.45 * Math.sin(2 * Math.PI * 220 * seconds + 0.1)
      + 0.32 * Math.sin(2 * Math.PI * 440 * seconds + 0.7)
      + 0.22 * Math.sin(2 * Math.PI * 880 * seconds + 1.2)
      + 0.16 * Math.sin(2 * Math.PI * 1320 * seconds + 0.5)
    );
    const beat = 0.35 + 0.65 * (Math.sin(2 * Math.PI * 1.91 * seconds + 0.33) ** 2);
    output[i] = amplitude * carrier * beat;
  }
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

  test('locates the actual browser chime while a structured song is playing', () => {
    const windowSamples = Math.round(RATE * 1.5);
    const trueOffsetMs = 400;
    const trueOffsetSamples = Math.round((RATE * trueOffsetMs) / 1000);
    const probe = browserProbe(RATE);
    const window = musicBed(windowSamples, 0.4);

    for (let i = 0; i < probe.length; i += 1) {
      window[trueOffsetSamples + i] += probe[i];
    }

    const result = locateProbe(toInt16(window), RATE);
    assert.ok(
      Math.abs(result.offsetSamples - trueOffsetSamples) <= Math.round((RATE * 10) / 1000),
      `expected browser probe near ${trueOffsetSamples} samples, got ${result.offsetSamples}`,
    );
    assert.ok(result.correlation > 0.65, `song masked the probe: ${result.correlation}`);
  });

  test('structured song without a probe does not become a false calibration match', () => {
    const windowSamples = Math.round(RATE * 1.5);
    const result = locateProbe(toInt16(musicBed(windowSamples, 0.4)), RATE);
    assert.ok(result.correlation < 0.5, `song was mistaken for the probe: ${result.correlation}`);
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
