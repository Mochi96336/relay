/**
 * Pitch-synchronous packet-loss concealment for the Mic timeline.
 *
 * A lost 10-20 ms of a sung note heard as silence is a click-gap-click that no
 * edge taper removes, because the listener hears the *absence*, not the edge.
 * Real-time voice stacks (G.711 Appendix I, Opus, WebRTC NetEQ) instead keep
 * the waveform going: repeat the last pitch period, fade it out if the loss
 * runs long, and blend back into real audio when it returns. This is the same
 * idea in its simplest dependable form.
 *
 * It is purely an audible fill. Callers must keep reporting the concealed span
 * as missing evidence: concealment changes what the room hears, never what
 * Relay claims it received.
 */

export type ConcealmentOptions = {
  sampleRate: number;
  /** Full-level repetition before the fade begins. */
  holdMs?: number;
  /** Repetition beyond this fades to silence; the rest of the gap stays silent. */
  maxConcealMs?: number;
};

export type Concealment = {
  /** Synthetic audio for the first `fill.length` samples of the gap. */
  fill: Int16Array;
  /** Samples of `next` that were blended from the continuation. */
  blendedNextSamples: number;
  /** Samples at the end of `previous` rewritten to join the repetition. */
  blendedPreviousSamples: number;
  periodSamples: number;
};

const MIN_PITCH_HZ = 60;
const MAX_PITCH_HZ = 500;
const CORRELATION_WINDOW_MS = 10;
const JOIN_MS = 4;

/**
 * Normalised autocorrelation pitch search over the end of `history`.
 * Returns the period in samples. Unvoiced input still returns the best lag:
 * repeating a short noise segment is a far smaller artefact than a hole.
 */
export function estimatePitchPeriod(history: Int16Array, sampleRate: number) {
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
  // shortest candidate that is nearly as good, so repetition stays tight.
  for (let divisor = 2; divisor <= 4; divisor += 1) {
    const candidate = Math.round(bestLag / divisor);
    if (candidate < minLag) break;
    if (correlationAt(candidate) >= bestScore * 0.9) {
      bestLag = candidate;
      break;
    }
  }
  return bestLag;
}

function clampInt16(value: number) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

/**
 * Builds concealment for a gap of `gapSamples` between `previous` (whose tail
 * may be rewritten in place over a fraction of a period) and `next` (whose head
 * is blended in place when the repetition is still audible at the gap's end).
 * `history` must end exactly where `previous` ends and include it.
 *
 * Returns null when there is not enough real history to find a period; the
 * caller then keeps its plain edge taper.
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

  const period = estimatePitchPeriod(history, sampleRate);
  if (period === null || period > history.length) return null;

  // The repetition source is the last real period. Take a copy before the
  // previous tail is rewritten below.
  const cycle = history.slice(history.length - period);
  const fadeSamples = Math.max(1, maxConcealSamples - holdSamples);
  const gainAt = (index: number) => (
    index < holdSamples ? 1 : Math.max(0, 1 - (index - holdSamples) / fadeSamples)
  );
  // Continuation index 0 is the sample right after `previous` ends.
  const continuation = (index: number) => cycle[index % period];

  // Join: ease the last fraction of a period of real audio toward the cycle's
  // own lead-in, so the first repeated sample follows without a step. The
  // lead-in to cycle[0] is the period before it, i.e. history shifted by one
  // period - exactly what a perfectly periodic signal would have contained.
  const joinSamples = Math.min(
    Math.max(1, Math.round((JOIN_MS * sampleRate) / 1000)),
    Math.floor(period / 2),
    previous.length,
    history.length - period,
  );
  for (let j = 0; j < joinSamples; j += 1) {
    const previousIndex = previous.length - joinSamples + j;
    const historyIndex = history.length - joinSamples + j;
    const weight = (j + 1) / (joinSamples + 1);
    previous[previousIndex] = clampInt16(
      previous[previousIndex] * (1 - weight) + history[historyIndex - period] * weight,
    );
  }

  const fillLength = Math.min(gapSamples, maxConcealSamples);
  const fill = new Int16Array(fillLength);
  for (let i = 0; i < fillLength; i += 1) {
    fill[i] = clampInt16(continuation(i) * gainAt(i));
  }

  // Leave the gap: if the repetition is still audible, crossfade into real
  // audio from the continued repetition. If it already faded out, the caller's
  // own fade-in from silence owns that edge.
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
    blendedPreviousSamples: joinSamples,
    periodSamples: period,
  };
}
