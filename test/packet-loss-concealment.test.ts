import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { concealGap, estimatePitchPeriod } from '../src/packet-loss-concealment.js';

const RATE = 48_000;

/** A voiced tone with a few harmonics, like a sung vowel. */
function voiced(length: number, f0: number, offset = 0) {
  const samples = new Int16Array(length);
  for (let i = 0; i < length; i += 1) {
    const t = (i + offset) / RATE;
    samples[i] = Math.round(
      8_000 * Math.sin(2 * Math.PI * f0 * t)
      + 3_000 * Math.sin(2 * Math.PI * 2 * f0 * t)
      + 1_500 * Math.sin(2 * Math.PI * 3 * f0 * t),
    );
  }
  return samples;
}

function maxAdjacentStep(...parts: Int16Array[]) {
  let previous: number | null = null;
  let max = 0;
  for (const part of parts) {
    for (const sample of part) {
      if (previous !== null) max = Math.max(max, Math.abs(sample - previous));
      previous = sample;
    }
  }
  return max;
}

function maxNaturalStep(samples: Int16Array) {
  return maxAdjacentStep(samples);
}

describe('estimatePitchPeriod', () => {
  for (const f0 of [110, 220, 440]) {
    it(`finds the ${f0} Hz period of a harmonic tone rather than an octave of it`, () => {
      const period = estimatePitchPeriod(voiced(2_048, f0), RATE);
      assert.ok(period !== null);
      assert.ok(Math.abs(period - RATE / f0) <= 2, `period ${period} for ${RATE / f0}`);
    });
  }

  it('declines digital silence and too-short history', () => {
    assert.equal(estimatePitchPeriod(new Int16Array(2_048), RATE), null);
    assert.equal(estimatePitchPeriod(voiced(200, 220), RATE), null);
  });
});

describe('concealGap', () => {
  it('continues a sung note through a 20 ms hole close to what was actually sung', () => {
    const f0 = 220;
    const whole = voiced(2_048 + 960 + 960, f0);
    const history = whole.slice(0, 2_048);
    const previous = history.slice(2_048 - 960);
    const truth = whole.slice(2_048, 2_048 + 960);
    const next = whole.slice(2_048 + 960);
    const nextBefore = next.slice();

    const concealment = concealGap(history, previous, next, 960, { sampleRate: RATE });
    assert.ok(concealment);
    assert.equal(concealment.fill.length, 960);

    // Over the full-level hold the repetition tracks the real waveform.
    let error = 0;
    let energy = 0;
    for (let i = 0; i < 480; i += 1) {
      error += (concealment.fill[i] - truth[i]) ** 2;
      energy += truth[i] ** 2;
    }
    assert.ok(error / energy < 0.05, `held repetition diverged: ${(error / energy).toFixed(3)}`);

    const natural = maxNaturalStep(whole);
    const step = maxAdjacentStep(previous, concealment.fill, next);
    assert.ok(step <= natural * 1.5, `joins must not click: ${step} vs natural ${natural}`);
    assert.deepEqual(
      next.subarray(concealment.blendedNextSamples),
      nextBefore.subarray(concealment.blendedNextSamples),
      'only the bounded join of the received audio is touched',
    );
  });

  it('fades a long loss to silence and leaves the rest of the hole empty', () => {
    const history = voiced(2_048, 220);
    const previous = history.slice(2_048 - 960);
    const next = voiced(960, 220, 2_048 + 9_600);
    const concealment = concealGap(history, previous, next, 9_600, { sampleRate: RATE });
    assert.ok(concealment);
    assert.equal(concealment.fill.length, Math.round(RATE * 0.06), 'repetition is bounded to 60 ms');
    assert.equal(concealment.blendedNextSamples, 0, 'a faded repetition does not blend into recovery');
    const tail = concealment.fill.subarray(concealment.fill.length - 48);
    assert.ok(tail.every((sample) => Math.abs(sample) < 400), 'the repetition has faded by its end');
  });

  it('declines when the history holds no signal to repeat', () => {
    const history = new Int16Array(2_048);
    assert.equal(concealGap(history, history.slice(1_000), null, 960, { sampleRate: RATE }), null);
  });

  it('keeps the first 10 ms exact but varies later unvoiced concealment across real history', () => {
    let state = 1;
    const history = new Int16Array(4_096).map(() => {
      state = (state * 1_103_515_245 + 12_345) >>> 0;
      return ((state >>> 16) % 4_000) - 2_000;
    });
    const previous = history.slice(history.length - 960);
    const gapSamples = Math.round(RATE * 0.06);
    const concealment = concealGap(history, previous, null, gapSamples, { sampleRate: RATE });
    assert.ok(concealment);
    assert.equal(concealment.fill.length, gapSamples);
    assert.ok(concealment.historyPeriods >= 2);

    const period = concealment.periodSamples;
    const cycle = history.slice(history.length - period);
    const holdSamples = Math.round(RATE * 0.01);
    const fadeSamples = gapSamples - holdSamples;
    const gainAt = (index: number) => (
      index < holdSamples ? 1 : Math.max(0, 1 - (index - holdSamples) / fadeSamples)
    );

    // Preserve the already-good short-loss behavior exactly: the first 10 ms
    // is still the most recent estimated period.
    for (let index = 0; index < holdSamples; index += 1) {
      assert.equal(
        concealment.fill[index],
        cycle[index % period],
        `short-loss concealment changed at sample ${index}`,
      );
    }

    // Old Relay repeated that same cycle for the full 60 ms and only changed
    // amplitude. Once the loss outlives 10 ms, real older periods must add
    // enough variation that the output is no longer that synthetic loop.
    let divergence = 0;
    let baselineEnergy = 0;
    for (let index = holdSamples; index < holdSamples * 3; index += 1) {
      const baseline = Math.round(cycle[index % period] * gainAt(index));
      divergence += (concealment.fill[index] - baseline) ** 2;
      baselineEnergy += baseline ** 2;
    }
    assert.ok(
      baselineEnergy > 0 && divergence / baselineEnergy > 0.1,
      `long concealment still behaves like one repeated cycle: ${(divergence / baselineEnergy).toFixed(3)}`,
    );
  });

  it('keeps unvoiced noise bounded instead of amplifying it', () => {
    let state = 1;
    const noise = new Int16Array(2_048).map(() => {
      state = (state * 1_103_515_245 + 12_345) >>> 0;
      return ((state >>> 16) % 4_000) - 2_000;
    });
    const concealment = concealGap(noise, noise.slice(1_000), null, 960, { sampleRate: RATE });
    assert.ok(concealment);
    assert.ok(concealment.fill.every((sample) => Math.abs(sample) <= 2_000));
  });
});
