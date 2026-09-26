/**
 * Positioned streaming resampler for Listen's room mix, used only when the
 * listener's AudioContext does not run at the mix rate (44.1 kHz devices).
 *
 * Interpolation is 4-point cubic (Catmull-Rom) rather than linear. Linear
 * interpolation is a triangle filter: it rolls the top octave off by about
 * 3 dB at 15 kHz and turns the fractional position into audible modulation of
 * the treble. The cubic needs one more source sample on each side, which the
 * causal clock provides by running two source samples late (about 42 us).
 */
const CAUSAL_DELAY_SAMPLES = 2;
const HISTORY_SAMPLES = 3;

function catmullRom(p0, p1, p2, p3, fraction) {
  return p1 + 0.5 * fraction * (
    p2 - p0 + fraction * (
      2 * p0 - 5 * p1 + 4 * p2 - p3 + fraction * (3 * (p1 - p2) + p3 - p0)
    )
  );
}

export function createStreamingResampler() {
  let activeSourceRate = null;
  let activeTargetRate = null;
  let expectedSourceSample = null;
  // The last source samples of the previous contiguous frame, oldest first.
  let history = [];

  function reset() {
    activeSourceRate = null;
    activeTargetRate = null;
    expectedSourceSample = null;
    history = [];
  }

  function rememberTail(input, continuous) {
    const carried = continuous ? history : [];
    const tail = [...carried, ...input.subarray(Math.max(0, input.length - HISTORY_SAMPLES))];
    history = tail.slice(Math.max(0, tail.length - HISTORY_SAMPLES));
  }

  function resample(input, {
    sourceRate,
    targetRate,
    firstSampleIndex,
  }) {
    if (!(input instanceof Float32Array)) {
      throw new TypeError('streaming resampler input must be Float32Array');
    }
    if (
      !Number.isFinite(sourceRate)
      || sourceRate <= 0
      || !Number.isFinite(targetRate)
      || targetRate <= 0
      || !Number.isSafeInteger(firstSampleIndex)
      || firstSampleIndex < 0
    ) {
      throw new TypeError('streaming resampler requires valid rates and source position');
    }
    if (input.length === 0) return new Float32Array(0);

    const sourceEnd = firstSampleIndex + input.length;
    if (!Number.isSafeInteger(sourceEnd)) {
      throw new RangeError('streaming resampler source range is not safe');
    }

    const continuous = (
      activeSourceRate === sourceRate
      && activeTargetRate === targetRate
      && expectedSourceSample === firstSampleIndex
      && history.length > 0
    );

    if (sourceRate === targetRate) {
      rememberTail(input, continuous);
      activeSourceRate = sourceRate;
      activeTargetRate = targetRate;
      expectedSourceSample = sourceEnd;
      return input;
    }

    const targetStart = Math.round((firstSampleIndex * targetRate) / sourceRate);
    const targetEnd = Math.round((sourceEnd * targetRate) / sourceRate);
    const outputLength = Math.max(0, targetEnd - targetStart);
    const output = new Float32Array(outputLength);

    const readSourceSample = (absoluteIndex) => {
      if (absoluteIndex < firstSampleIndex) {
        const back = firstSampleIndex - absoluteIndex;
        if (continuous && back <= history.length) return history[history.length - back];
        // One-time reset/start boundary. Clamp locally instead of pulling stale
        // PCM from a previous generation or a real monitor gap.
        return input[0];
      }
      if (absoluteIndex >= sourceEnd) {
        // The causal delay guarantees this is not needed in steady state, but
        // keep a bounded fallback for floating-point/range edge cases rather
        // than reading outside the packet.
        return input[input.length - 1];
      }
      return input[absoluteIndex - firstSampleIndex];
    };

    for (let offset = 0; offset < outputLength; offset += 1) {
      const targetIndex = targetStart + offset;

      // Delay the local playback interpolation clock by two source samples.
      // That makes all four taps causal: a boundary target can use the
      // previous packet tail plus the current packet head, so no 20 ms
      // packet-local sample hold is required even when upsampling.
      const sourcePosition = (targetIndex * sourceRate) / targetRate - CAUSAL_DELAY_SAMPLES;
      const sourceIndex = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndex;
      output[offset] = catmullRom(
        readSourceSample(sourceIndex - 1),
        readSourceSample(sourceIndex),
        readSourceSample(sourceIndex + 1),
        readSourceSample(sourceIndex + 2),
        fraction,
      );
    }

    rememberTail(input, continuous);
    activeSourceRate = sourceRate;
    activeTargetRate = targetRate;
    expectedSourceSample = sourceEnd;

    return output;
  }

  return { reset, resample };
}
