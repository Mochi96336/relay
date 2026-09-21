export function createStreamingLinearResampler() {
  let activeSourceRate = null;
  let activeTargetRate = null;
  let expectedSourceSample = null;
  let previousSourceSample = 0;
  let hasPreviousSourceSample = false;

  function reset() {
    activeSourceRate = null;
    activeTargetRate = null;
    expectedSourceSample = null;
    previousSourceSample = 0;
    hasPreviousSourceSample = false;
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
      && hasPreviousSourceSample
    );

    if (sourceRate === targetRate) {
      activeSourceRate = sourceRate;
      activeTargetRate = targetRate;
      expectedSourceSample = sourceEnd;
      previousSourceSample = input[input.length - 1];
      hasPreviousSourceSample = true;
      return input;
    }

    const targetStart = Math.round((firstSampleIndex * targetRate) / sourceRate);
    const targetEnd = Math.round((sourceEnd * targetRate) / sourceRate);
    const outputLength = Math.max(0, targetEnd - targetStart);
    const output = new Float32Array(outputLength);

    const readSourceSample = (absoluteIndex) => {
      if (absoluteIndex === firstSampleIndex - 1 && continuous) {
        return previousSourceSample;
      }
      if (absoluteIndex < firstSampleIndex) {
        // One-time reset/start boundary. Clamp locally instead of pulling stale
        // PCM from a previous generation or a real monitor gap.
        return input[0];
      }
      if (absoluteIndex >= sourceEnd) {
        // The one-source-sample causal delay guarantees this is not needed in
        // steady state, but keep a bounded fallback for floating-point/range
        // edge cases rather than reading outside the packet.
        return input[input.length - 1];
      }
      return input[absoluteIndex - firstSampleIndex];
    };

    for (let offset = 0; offset < outputLength; offset += 1) {
      const targetIndex = targetStart + offset;

      // Delay the local playback interpolation clock by one source sample.
      // That makes every endpoint causal: a boundary target can use the
      // previous packet tail plus the current packet head, so no 20 ms
      // packet-local sample hold is required even when upsampling.
      const sourcePosition = (targetIndex * sourceRate) / targetRate - 1;
      const sourceIndex = Math.floor(sourcePosition);
      const fraction = sourcePosition - sourceIndex;
      const a = readSourceSample(sourceIndex);
      const b = readSourceSample(sourceIndex + 1);
      output[offset] = a + (b - a) * fraction;
    }

    activeSourceRate = sourceRate;
    activeTargetRate = targetRate;
    expectedSourceSample = sourceEnd;
    previousSourceSample = input[input.length - 1];
    hasPreviousSourceSample = true;

    return output;
  }

  return { reset, resample };
}
