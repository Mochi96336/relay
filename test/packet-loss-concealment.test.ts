import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { concealGap, estimatePitch, estimatePitchPeriod } from '../src/packet-loss-concealment.js';

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

  it('keeps the first 10 ms of a note exact but varies later concealment across real periods', () => {
    // A held 150 Hz note whose timbre moves over the last 20 ms (the second
    // harmonic swells as the third fades): clearly periodic, yet each real
    // period differs from the one before. Unvoiced input is continued as
    // noise instead; see 'concealGap on unvoiced audio'.
    const f0 = 150;
    const morphSamples = Math.round(RATE * 0.02);
    const history = new Int16Array(4_096).map((_, i) => {
      const t = i / RATE;
      const morph = Math.min(1, Math.max(0, (i - (4_096 - morphSamples)) / morphSamples));
      return Math.round(
        8_000 * Math.sin(2 * Math.PI * f0 * t)
        + 6_000 * morph * Math.sin(2 * Math.PI * 2 * f0 * t)
        + 3_000 * (1 - morph) * Math.sin(2 * Math.PI * 3 * f0 * t),
      );
    });
    const previous = history.slice(history.length - 960);
    const gapSamples = Math.round(RATE * 0.06);
    const concealment = concealGap(history, previous, null, gapSamples, { sampleRate: RATE });
    assert.ok(concealment);
    assert.equal(concealment.voicing, 1);
    assert.equal(concealment.fill.length, gapSamples);
    assert.ok(concealment.historyPeriods >= 2);

    const period = concealment.periodSamples!;
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
      baselineEnergy > 0 && divergence / baselineEnergy > 0.02,
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

/** Deterministic Gaussian noise (32-bit LCG + Box-Muller). */
function gaussian(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state + 0.5) / 0x1_0000_0000;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

const NOISES: Record<string, (length: number, seed: number) => Int16Array> = {
  'white noise': (length, seed) => {
    const g = gaussian(seed);
    return Int16Array.from({ length }, () => g() * 3_000);
  },
  'room rumble': (length, seed) => {
    const g = gaussian(seed);
    let y = 0;
    return Int16Array.from({ length }, () => (y = 0.9 * y + g() * 800));
  },
  'hiss and fricatives': (length, seed) => {
    const g = gaussian(seed);
    let previous = 0;
    return Int16Array.from({ length }, () => {
      const x = g() * 3_000;
      const value = x - previous;
      previous = x;
      return value;
    });
  },
};

/** Strongest normalised autocorrelation at any 100-500 Hz lag: how buzzy it is. */
function tonality(samples: Int16Array) {
  let best = 0;
  for (let lag = 96; lag <= 480 && lag < samples.length; lag += 1) {
    let cross = 0;
    let a = 0;
    let b = 0;
    for (let i = lag; i < samples.length; i += 1) {
      cross += samples[i] * samples[i - lag];
      a += samples[i] ** 2;
      b += samples[i - lag] ** 2;
    }
    if (a > 0 && b > 0) best = Math.max(best, cross / Math.sqrt(a * b));
  }
  return best;
}

function rms(samples: ArrayLike<number>) {
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] ** 2;
  return Math.sqrt(sum / samples.length);
}

/** Share of energy in sample-to-sample change: a crude spectral tilt. */
function brightness(samples: ArrayLike<number>) {
  let change = 0;
  let energy = 0;
  for (let i = 1; i < samples.length; i += 1) {
    change += (samples[i] - samples[i - 1]) ** 2;
    energy += samples[i] ** 2;
  }
  return change / energy;
}

describe('estimatePitch voicing', () => {
  it('reports a held note as periodic and noise as not', () => {
    assert.ok(estimatePitch(voiced(2_048, 220), RATE)!.correlation > 0.95);
    for (const [name, make] of Object.entries(NOISES)) {
      for (let seed = 1; seed <= 20; seed += 1) {
        const pitch = estimatePitch(make(2_048, seed), RATE);
        assert.ok(pitch, name);
        assert.ok(pitch.correlation < 0.5, `${name} #${seed} read as periodic: ${pitch.correlation.toFixed(2)}`);
      }
    }
  });
});

describe('concealGap on unvoiced audio', () => {
  for (const [name, make] of Object.entries(NOISES)) {
    it(`continues ${name} as noise, not as a buzz`, () => {
      for (let seed = 1; seed <= 10; seed += 1) {
        const whole = make(2_048 + 960 * 2, seed);
        const history = whole.slice(0, 2_048);
        const previous = history.slice(2_048 - 960);
        const previousBefore = previous.slice();
        const next = whole.slice(2_048 + 960);
        const concealment = concealGap(history, previous, next, 960, { sampleRate: RATE });
        assert.ok(concealment, `${name} #${seed}`);
        assert.equal(concealment.voicing, 0);
        assert.equal(concealment.periodSamples, null);
        assert.deepEqual(previous, previousBefore, 'noise needs no rewritten join');

        // A repeated slice of noise is a tone at its repetition rate (~0.9+).
        const fill = concealment.fill;
        assert.ok(tonality(fill) < 0.5, `${name} #${seed} became tonal: ${tonality(fill).toFixed(2)}`);

        // Same level and colour as the 20 ms it learned from, over the
        // full-level hold. (A shorter reference is dominated by how much
        // low-frequency noise happens to swing in 10 ms.)
        const recent = history.subarray(2_048 - 960);
        const hold = fill.subarray(0, 480);
        const level = rms(hold) / rms(recent);
        assert.ok(level > 0.5 && level < 1.3, `${name} #${seed} level ${level.toFixed(2)}`);
        const colour = brightness(hold) / brightness(recent);
        assert.ok(colour > 0.6 && colour < 1.6, `${name} #${seed} colour ${colour.toFixed(2)}`);

        // Never louder than the loudest real sample, and no step into it.
        let peak = 0;
        for (const sample of history.subarray(2_048 - 960)) peak = Math.max(peak, Math.abs(sample));
        assert.ok(fill.every((sample) => Math.abs(sample) <= peak));
        const natural = maxNaturalStep(whole);
        assert.ok(
          maxAdjacentStep(previous, fill, next) <= natural * 1.5,
          `${name} #${seed} joins must not click`,
        );
      }
    });
  }

  it('mixes repetition and noise for a breathy note, keeping its pitch', () => {
    const g = gaussian(5);
    const f0 = 220;
    const whole = new Int16Array(2_048 + 960 * 2);
    for (let i = 0; i < whole.length; i += 1) {
      const t = i / RATE;
      whole[i] = Math.round(
        4_000 * Math.sin(2 * Math.PI * f0 * t) + 1_500 * Math.sin(2 * Math.PI * 2 * f0 * t) + g() * 1_600,
      );
    }
    const history = whole.slice(0, 2_048);
    const concealment = concealGap(history, history.slice(2_048 - 960), whole.slice(2_048 + 960), 960, {
      sampleRate: RATE,
    });
    assert.ok(concealment);
    assert.ok(concealment.voicing > 0 && concealment.voicing < 1, `voicing ${concealment.voicing}`);
    assert.ok(Math.abs(concealment.periodSamples! - RATE / f0) <= 2);
    const level = rms(concealment.fill.subarray(0, 480)) / rms(history.subarray(2_048 - 480));
    assert.ok(level > 0.6 && level < 1.3, `level ${level.toFixed(2)}`);
  });

  it('still repeats a clear note at full voicing', () => {
    const history = voiced(2_048, 220);
    const concealment = concealGap(history, history.slice(2_048 - 960), null, 960, { sampleRate: RATE });
    assert.ok(concealment);
    assert.equal(concealment.voicing, 1);
    assert.ok(Math.abs(concealment.periodSamples! - RATE / 220) <= 2);
  });
});
