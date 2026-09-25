/**
 * Packet-loss concealment for the Mic timeline.
 *
 * A lost 10-20 ms of a sung note heard as silence is a click-gap-click that no
 * edge taper removes, because the listener hears the *absence*, not the edge.
 * Real-time voice stacks (G.711 Appendix I, Opus, WebRTC NetEQ) instead keep
 * the waveform going: repeat the last pitch period, fade it out if the loss
 * runs long, and blend back into real audio when it returns.
 *
 * Only voiced audio has a period to repeat. Breath, fricatives, room hiss and
 * interface noise have none, and repeating a "best" 2-16 ms slice of them turns
 * broadband noise into a 60-500 Hz buzz. So, like NetEQ's expand, the fill
 * follows how periodic the history actually is: a clear period is repeated;
 * noise is continued as noise with the same spectral envelope (an LPC filter
 * driven by white noise at the history's residual level); in between, the two
 * are mixed at constant power.
 *
 * It is purely an audible fill. Callers must keep reporting the concealed span
 * as missing evidence: concealment changes what the room hears, never what
 * Relay claims it received.
 */

export type ConcealmentOptions = {
  sampleRate: number;
  /** Full-level fill before the fade begins. */
  holdMs?: number;
  /** Fill beyond this fades to silence; the rest of the gap stays silent. */
  maxConcealMs?: number;
};

export type Concealment = {
  /** Synthetic audio for the first `fill.length` samples of the gap. */
  fill: Int16Array;
  /** Samples of `next` that were blended from the continuation. */
  blendedNextSamples: number;
  /** Samples at the end of `previous` rewritten to join the repetition. */
  blendedPreviousSamples: number;
  /** Repeated period, or null when the fill is noise only. */
  periodSamples: number | null;
  /** Real historical pitch periods used to vary repetition after the first 10 ms. */
  historyPeriods: number;
  /** Share of the fill's power that is periodic repetition, 0..1. */
  voicing: number;
};

export type PitchEstimate = {
  periodSamples: number;
  /** Normalised autocorrelation at that period: near 1 for a held note, near 0 for noise. */
  correlation: number;
};

const MIN_PITCH_HZ = 60;
const MAX_PITCH_HZ = 500;
const CORRELATION_WINDOW_MS = 10;
const JOIN_MS = 4;
/**
 * For a periodic signal plus independent noise, the normalised correlation at
 * the period is close to the periodic share of the power: measured on this
 * estimator, a harmonic note 6 dB above noise reads 0.80, 0 dB reads 0.53.
 * Pure noise still reads up to about 0.43, because the search keeps the best
 * of several hundred lags; below that nothing is periodic.
 */
const NOISE_CORRELATION_CEILING = 0.42;
const VOICING_RAMP = 0.1;
/** Above this the history is a held note: repeat it, add no noise. */
const FULLY_VOICED_CORRELATION = 0.95;
const LPC_ORDER = 16;
const LPC_WINDOW_MS = 20;
/** Bandwidth expansion: keeps the synthesis filter's poles off the unit circle. */
const LPC_BANDWIDTH_EXPANSION = 0.98;

/**
 * Normalised autocorrelation pitch search over the end of `history`: the best
 * period in 60-500 Hz and how periodic the signal really is there. Noise
 * always has *some* best lag; its correlation is what says it is not a pitch.
 */
export function estimatePitch(history: Int16Array, sampleRate: number): PitchEstimate | null {
  const minLag = Math.max(2, Math.floor(sampleRate / MAX_PITCH_HZ));
  const maxLag = Math.floor(sampleRate / MIN_PITCH_HZ);
  const window = Math.round((CORRELATION_WINDOW_MS * sampleRate) / 1000);
  const usableMaxLag = Math.min(maxLag, history.length - window);
  if (usableMaxLag < minLag) return null;

  const end = history.length;
  const segmentStart = end - window;
  let segmentEnergy = 0;
  for (let i = segmentStart; i < end; i += 1) segmentEnergy += history[i] * history[i];
  if (segmentEnergy === 0) return null;

  const correlationAt = (lag: number) => {
    let cross = 0;
    let energy = 0;
    for (let i = segmentStart; i < end; i += 1) {
      const lagged = history[i - lag];
      cross += history[i] * lagged;
      energy += lagged * lagged;
    }
    return energy > 0 ? cross / Math.sqrt(segmentEnergy * energy) : -1;
  };

  // Coarse pass every second lag, then refine around the winner. The search
  // runs once per real gap, never per frame.
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= usableMaxLag; lag += 2) {
    const score = correlationAt(lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  for (let lag = Math.max(minLag, bestLag - 1); lag <= Math.min(usableMaxLag, bestLag + 1); lag += 1) {
    const score = correlationAt(lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  // Octave guard: a period and its double correlate almost equally. Prefer the
  // shortest candidate that is nearly as good, so repetition stays tight. Only
  // a real period has octaves; for noise the comparison means nothing.
  if (bestScore > 0) {
    for (let divisor = 2; divisor <= 4; divisor += 1) {
      const candidate = Math.round(bestLag / divisor);
      if (candidate < minLag) break;
      const score = correlationAt(candidate);
      if (score >= bestScore * 0.9) {
        bestLag = candidate;
        bestScore = score;
        break;
      }
    }
  }
  return { periodSamples: bestLag, correlation: Math.max(0, bestScore) };
}

/** The best period in samples, whether or not the history is voiced. */
export function estimatePitchPeriod(history: Int16Array, sampleRate: number) {
  return estimatePitch(history, sampleRate)?.periodSamples ?? null;
}

/** Share of fill power given to periodic repetition for a pitch correlation. */
export function voicingForCorrelation(correlation: number) {
  if (correlation >= FULLY_VOICED_CORRELATION) return 1;
  if (correlation <= NOISE_CORRELATION_CEILING) return 0;
  return correlation * Math.min(1, (correlation - NOISE_CORRELATION_CEILING) / VOICING_RAMP);
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/**
 * Linear-prediction coefficients (autocorrelation method, Levinson-Durbin) of
 * a Hann-windowed segment. The windowed autocorrelation keeps the synthesis
 * filter stable; bandwidth expansion keeps it from ringing.
 */
function lpcCoefficients(segment: Float64Array, order: number) {
  const n = segment.length;
  const windowed = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    windowed[i] = segment[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n));
  }
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag += 1) {
    let sum = 0;
    for (let i = lag; i < n; i += 1) sum += windowed[i] * windowed[i - lag];
    r[lag] = sum;
  }
  // White-noise correction: a -40 dB floor so a nearly pure tone stays solvable.
  r[0] *= 1.0001;
  if (r[0] <= 0) return null;

  const a = new Float64Array(order + 1);
  const previous = new Float64Array(order + 1);
  let error = r[0];
  for (let i = 1; i <= order; i += 1) {
    let acc = r[i];
    for (let j = 1; j < i; j += 1) acc -= a[j] * r[i - j];
    const k = acc / error;
    if (!Number.isFinite(k) || Math.abs(k) >= 1) break;
    previous.set(a);
    a[i] = k;
    for (let j = 1; j < i; j += 1) a[j] = previous[j] - k * previous[i - j];
    error *= 1 - k * k;
    if (error <= 0) break;
  }
  let gamma = 1;
  for (let i = 1; i <= order; i += 1) {
    gamma *= LPC_BANDWIDTH_EXPANSION;
    a[i] *= gamma;
  }
  return a;
}

/**
 * `length` samples continuing `history` as noise with its spectral envelope:
 * the LPC synthesis filter starts from the real samples, so the first
 * synthetic sample follows the last real one, and is driven by white noise at
 * the level of the history's own prediction residual. Never louder than the
 * loudest real sample it learned from.
 */
function noiseContinuation(history: Int16Array, length: number, sampleRate: number) {
  const order = Math.min(LPC_ORDER, history.length - 1);
  const windowLength = Math.min(history.length, Math.round((LPC_WINDOW_MS * sampleRate) / 1000));
  if (order < 1 || windowLength <= order * 2) return null;
  const segment = Float64Array.from(history.subarray(history.length - windowLength));
  const a = lpcCoefficients(segment, order);
  if (!a) return null;

  let peak = 0;
  let residualEnergy = 0;
  for (let i = order; i < segment.length; i += 1) {
    let predicted = 0;
    for (let k = 1; k <= order; k += 1) predicted += a[k] * segment[i - k];
    residualEnergy += (segment[i] - predicted) ** 2;
  }
  for (const sample of segment) peak = Math.max(peak, Math.abs(sample));
  const excitationRms = Math.sqrt(residualEnergy / (segment.length - order));

  // Deterministic excitation: the same loss conceals the same way.
  let seed = 0x9e37_79b9;
  for (let i = segment.length - 32; i < segment.length; i += 1) {
    seed = Math.imul(seed ^ (segment[i] & 0xffff), 0x85eb_ca6b) >>> 0;
  }
  const white = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    // Uniform on [-sqrt(3), sqrt(3)): unit variance.
    return ((seed / 0x1_0000_0000) * 2 - 1) * Math.sqrt(3);
  };

  const state = Float64Array.from(segment.subarray(segment.length - order));
  const output = new Float64Array(length);
  for (let i = 0; i < length; i += 1) {
    let value = excitationRms * white();
    // state[order - k] is the sample k steps back.
    for (let k = 1; k <= order; k += 1) value += a[k] * state[order - k];
    value = Math.max(-peak, Math.min(peak, value));
    state.copyWithin(0, 1);
    state[order - 1] = value;
    output[i] = value;
  }
  return output;
}

/**
 * Builds concealment for a gap of `gapSamples` between `previous` (whose tail
 * may be rewritten in place over a fraction of a period) and `next` (whose head
 * is blended in place when the fill is still audible at the gap's end).
 * `history` must end exactly where `previous` ends and include it.
 *
 * Returns null when there is not enough real history to continue; the caller
 * then keeps its plain edge taper.
 */
export function concealGap(
  history: Int16Array,
  previous: Int16Array,
  next: Int16Array | null,
  gapSamples: number,
  options: ConcealmentOptions,
): Concealment | null {
  const { sampleRate } = options;
  const holdSamples = Math.round(((options.holdMs ?? 10) * sampleRate) / 1000);
  const maxConcealSamples = Math.round(((options.maxConcealMs ?? 60) * sampleRate) / 1000);
  if (gapSamples <= 0 || previous.length === 0) return null;

  const pitch = estimatePitch(history, sampleRate);
  if (pitch === null || pitch.periodSamples > history.length) return null;
  const voicing = voicingForCorrelation(pitch.correlation);
  const period = voicing > 0 ? pitch.periodSamples : null;

  const fadeSamples = Math.max(1, maxConcealSamples - holdSamples);
  const gainAt = (index: number) => (
    index < holdSamples ? 1 : Math.max(0, 1 - (index - holdSamples) / fadeSamples)
  );
  const fillLength = Math.min(gapSamples, maxConcealSamples);
  const joinLimit = Math.max(1, Math.round((JOIN_MS * sampleRate) / 1000));
  const joinSamples = Math.min(
    joinLimit,
    previous.length,
    ...(period === null ? [] : [Math.floor(period / 2), history.length - period]),
  );

  // Constant-power mix of the two continuations: they are uncorrelated.
  const noiseWeight = Math.sqrt(1 - voicing);
  const noise = noiseWeight > 0
    ? noiseContinuation(history, fillLength + joinSamples, sampleRate)
    : null;
  if (noiseWeight > 0 && noise === null && period === null) return null;
  // Wrapping from a cycle's last sample back to its first is a splice unless
  // the history is exactly periodic. A note or vowel change inside the history
  // leaves one timbre at the cycle's end and another at its start, and the
  // repetition then clicks at every wrap. Ease the last quarter period of each
  // cycle into the audio that led into its first sample, as G.711 Appendix I
  // overlap-adds at each period boundary. An exactly periodic cycle already
  // equals its lead-in there and is unchanged.
  const wrapSamples = period === null
    ? 0
    : Math.max(0, Math.min(Math.floor(period / 4), history.length - period));
  // The first 10 ms repeats the most recent period. Beyond that, a single
  // short cycle becomes an audible harmonic "beep"; G.711 Appendix I answers by
  // drawing on more real pitch history as the erasure continues. Keep up to
  // three contiguous real periods (each with its own lead-in in the history)
  // and move between them gradually at equal pitch phase, so the waveform
  // gains natural variation without a new splice at each 10 ms boundary.
  const historyPeriods = period === null
    ? 0
    : Math.max(1, Math.min(3, Math.floor((history.length - wrapSamples) / period)));
  const variationWindowSamples = Math.max(1, holdSamples);
  const historicalPeriodSample = (periodIndex: number, phase: number) => {
    const cycleStart = history.length - (periodIndex + 1) * period!;
    const value = history[cycleStart + phase];
    const intoWrap = phase - (period! - wrapSamples);
    if (intoWrap < 0) return value;
    // Reaches the sample just before the cycle's start at its last phase.
    const weight = (intoWrap + 1) / wrapSamples;
    return value * (1 - weight) + history[cycleStart + phase - period!] * weight;
  };
  const periodicAt = (index: number) => {
    const phase = index % period!;
    if (index < variationWindowSamples || historyPeriods === 1) {
      return historicalPeriodSample(0, phase);
    }
    const segment = Math.floor(index / variationWindowSamples);
    const offset = index % variationWindowSamples;
    const fromPeriod = (segment - 1) % historyPeriods;
    const toPeriod = segment % historyPeriods;
    const weight = variationWindowSamples <= 1 ? 1 : offset / (variationWindowSamples - 1);
    return historicalPeriodSample(fromPeriod, phase) * (1 - weight)
      + historicalPeriodSample(toPeriod, phase) * weight;
  };
  // Continuation index 0 is the sample right after `previous` ends.
  // A part that could not be built leaves the other at full level.
  const continuation = (index: number) => {
    if (period === null) return noise![index];
    if (!noise) return periodicAt(index);
    // The join below hands over to the periodic part alone, so the noise part
    // enters over the same span, at constant power, instead of arriving at its
    // full weight on the first concealed sample.
    const entering = Math.min(1, (index + 1) / (joinSamples + 1));
    const noiseGain = noiseWeight * entering;
    return Math.sqrt(1 - noiseGain * noiseGain) * periodicAt(index) + noiseGain * noise[index];
  };

  // Join: ease the last fraction of a period of real audio toward the cycle's
  // own lead-in, so the first repeated sample follows without a step. The
  // lead-in to cycle[0] is the period before it, i.e. history shifted by one
  // period - exactly what a perfectly periodic signal would have contained.
  let blendedPreviousSamples = 0;
  if (period !== null) {
    blendedPreviousSamples = joinSamples;
    for (let j = 0; j < joinSamples; j += 1) {
      const previousIndex = previous.length - joinSamples + j;
      const historyIndex = history.length - joinSamples + j;
      const weight = (j + 1) / (joinSamples + 1);
      previous[previousIndex] = clampInt16(
        previous[previousIndex] * (1 - weight) + history[historyIndex - period] * weight,
      );
    }
  }

  const fill = new Int16Array(fillLength);
  for (let i = 0; i < fillLength; i += 1) {
    fill[i] = clampInt16(continuation(i) * gainAt(i));
  }

  // Leave the gap: if the fill is still audible, crossfade into real audio
  // from its continuation. If it already faded out, the caller's own fade-in
  // from silence owns that edge.
  let blendedNextSamples = 0;
  if (next && fillLength === gapSamples) {
    const endGain = gainAt(gapSamples);
    if (endGain > 0) {
      blendedNextSamples = Math.min(joinSamples, next.length);
      for (let j = 0; j < blendedNextSamples; j += 1) {
        const weight = (j + 1) / (blendedNextSamples + 1);
        const synthetic = continuation(gapSamples + j) * gainAt(gapSamples + j);
        next[j] = clampInt16(synthetic * (1 - weight) + next[j] * weight);
      }
    }
  }

  return {
    fill,
    blendedNextSamples,
    blendedPreviousSamples,
    periodSamples: period,
    historyPeriods,
    voicing,
  };
}
