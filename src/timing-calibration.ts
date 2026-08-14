export type TimingCalibrationAnalysis = {
  micLagMs: number;
  confidence: number;
  segmentLagsMs: number[];
  segmentCorrelations: number[];
  micLevelDbfs: number;
  backingLevelDbfs: number;
};

type LagSearchResult = {
  lag: number;
  correlation: number;
};

const ENVELOPE_FRAME_MS = 5;
const MAX_LAG_MS = 2_000;
const LOCAL_SEARCH_RADIUS_MS = 150;
const LOCAL_SUPPORT_RADIUS_MS = 100;
const LOCAL_MEAN_RADIUS_MS = 125;
const SEGMENT_LENGTH_MS = 650;
const SEGMENT_COUNT: number = 5;
const SEGMENT_EDGE_MARGIN_MS = 120;
const MIN_GLOBAL_CORRELATION = 0.12;
const MIN_LOCAL_CORRELATION = 0.06;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function levelDbfs(samples: Int16Array) {
  if (samples.length === 0) return -100;
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = samples[i] / 32768;
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function featureEnvelope(samples: Int16Array, sampleRate: number) {
  const frameSamples = Math.max(1, Math.round((sampleRate * ENVELOPE_FRAME_MS) / 1000));
  const frameCount = Math.floor(samples.length / frameSamples);
  const energy = new Float64Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSamples;
    let sumSquares = 0;
    for (let i = 0; i < frameSamples; i += 1) {
      const value = samples[start + i] / 32768;
      sumSquares += value * value;
    }
    const rms = Math.sqrt(sumSquares / frameSamples);
    energy[frame] = Math.log1p(rms * 80);
  }

  const smoothed = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const before = energy[Math.max(0, i - 1)];
    const current = energy[i];
    const after = energy[Math.min(frameCount - 1, i + 1)];
    smoothed[i] = (before + current * 2 + after) / 4;
  }

  // Remove slow loudness changes. The remaining short-term envelope survives
  // speaker / room / microphone coloration much better than raw PCM matching.
  const radius = Math.max(1, Math.round(LOCAL_MEAN_RADIUS_MS / ENVELOPE_FRAME_MS));
  const prefix = new Float64Array(frameCount + 1);
  for (let i = 0; i < frameCount; i += 1) prefix[i + 1] = prefix[i] + smoothed[i];

  const feature = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const from = Math.max(0, i - radius);
    const to = Math.min(frameCount, i + radius + 1);
    const mean = (prefix[to] - prefix[from]) / Math.max(1, to - from);
    feature[i] = smoothed[i] - mean;
  }

  return feature;
}

function normalizedCorrelation(
  backing: Float64Array,
  mic: Float64Array,
  start: number,
  length: number,
  lag: number,
) {
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < length; i += 1) {
    sumX += backing[start + i];
    sumY += mic[start + i + lag];
  }

  const meanX = sumX / length;
  const meanY = sumY / length;
  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;

  for (let i = 0; i < length; i += 1) {
    const x = backing[start + i] - meanX;
    const y = mic[start + i + lag] - meanY;
    covariance += x * y;
    varianceX += x * x;
    varianceY += y * y;
  }

  const denominator = Math.sqrt(varianceX * varianceY);
  return denominator > 1e-12 ? covariance / denominator : -1;
}

function bestLagForSegment(
  backing: Float64Array,
  mic: Float64Array,
  start: number,
  length: number,
  minLagFrames: number,
  maxLagFrames: number,
): LagSearchResult {
  let bestLag = 0;
  let bestCorrelation = -1;

  for (let lag = minLagFrames; lag <= maxLagFrames; lag += 1) {
    const micStart = start + lag;
    if (micStart < 0 || micStart + length > mic.length) continue;
    const correlation = normalizedCorrelation(backing, mic, start, length, lag);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  return { lag: bestLag, correlation: bestCorrelation };
}

function bestLagAcrossOverlap(
  backing: Float64Array,
  mic: Float64Array,
  maxLagFrames: number,
): LagSearchResult {
  let bestLag = 0;
  let bestCorrelation = -1;
  const minimumOverlapFrames = Math.round(3_000 / ENVELOPE_FRAME_MS);

  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
    const start = Math.max(0, -lag);
    const length = Math.min(backing.length - start, mic.length - (start + lag));
    if (length < minimumOverlapFrames) continue;

    const correlation = normalizedCorrelation(backing, mic, start, length, lag);
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }

  return { lag: bestLag, correlation: bestCorrelation };
}

function validationStarts(
  frameCount: number,
  segmentLength: number,
  minLagFrames: number,
  maxLagFrames: number,
) {
  let first = Math.max(0, -minLagFrames);
  let last = Math.min(
    frameCount - segmentLength,
    frameCount - segmentLength - maxLagFrames,
  );

  const margin = Math.round(SEGMENT_EDGE_MARGIN_MS / ENVELOPE_FRAME_MS);
  if (last - first > margin * 2) {
    first += margin;
    last -= margin;
  }

  if (last < first) return [];
  if (SEGMENT_COUNT === 1) return [Math.round((first + last) / 2)];

  return Array.from({ length: SEGMENT_COUNT }, (_, index) => (
    Math.round(first + ((last - first) * index) / (SEGMENT_COUNT - 1))
  ));
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function signedMs(value: number) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded} ms`;
}

export function analyzeTimingCalibration(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
): TimingCalibrationAnalysis {
  if (sampleRate <= 0) throw new Error('Invalid calibration sample rate.');

  const requiredSamples = Math.round(sampleRate * 6);
  if (micSamples.length < requiredSamples || backingSamples.length < requiredSamples) {
    throw new Error('Calibration needs six seconds from both microphone and backing.');
  }

  const mic = micSamples.subarray(0, requiredSamples);
  const backing = backingSamples.subarray(0, requiredSamples);
  const micLevelDbfs = levelDbfs(mic);
  const backingLevelDbfs = levelDbfs(backing);

  if (backingLevelDbfs < -50) {
    throw new Error('Desktop source is too quiet for timing calibration.');
  }
  if (micLevelDbfs < -60) {
    throw new Error('Phone speaker bleed is too quiet. Raise phone volume and try again.');
  }

  const micFeature = featureEnvelope(mic, sampleRate);
  const backingFeature = featureEnvelope(backing, sampleRate);
  const maxLagFrames = Math.round(MAX_LAG_MS / ENVELOPE_FRAME_MS);

  // First search the full usable overlap. At ±2 s there are still four seconds
  // of common material in a six-second capture, which is much harder for a
  // repeated beat to fool than several independent short windows.
  const global = bestLagAcrossOverlap(backingFeature, micFeature, maxLagFrames);
  const globalLagMs = global.lag * ENVELOPE_FRAME_MS;

  if (global.correlation < MIN_GLOBAL_CORRELATION) {
    throw new Error(
      `Calibration signal is weak (corr ${global.correlation.toFixed(2)}). ` +
      'Use a louder section with clear drums or attacks and stay quiet for six seconds.',
    );
  }

  // Then validate only near that coarse answer. Segment locations are chosen
  // inside the actual overlap, so large lags near ±2 s still get five windows.
  const localRadiusFrames = Math.round(LOCAL_SEARCH_RADIUS_MS / ENVELOPE_FRAME_MS);
  const supportRadiusFrames = Math.round(LOCAL_SUPPORT_RADIUS_MS / ENVELOPE_FRAME_MS);
  const minLocalLag = Math.max(-maxLagFrames, global.lag - localRadiusFrames);
  const maxLocalLag = Math.min(maxLagFrames, global.lag + localRadiusFrames);
  const segmentLength = Math.round(SEGMENT_LENGTH_MS / ENVELOPE_FRAME_MS);
  const starts = validationStarts(
    backingFeature.length,
    segmentLength,
    minLocalLag,
    maxLocalLag,
  );

  if (starts.length < 3) {
    throw new Error('Not enough overlapping audio to validate this timing result.');
  }

  const results = starts.map((start) => bestLagForSegment(
    backingFeature,
    micFeature,
    start,
    segmentLength,
    minLocalLag,
    maxLocalLag,
  ));

  const segmentLagsMs = results.map((result) => result.lag * ENVELOPE_FRAME_MS);
  const segmentCorrelations = results.map((result) => result.correlation);
  const support = results.filter((result) => (
    result.correlation >= MIN_LOCAL_CORRELATION &&
    Math.abs(result.lag - global.lag) <= supportRadiusFrames
  ));

  if (support.length < 3) {
    const windows = segmentLagsMs.map(signedMs).join(' / ');
    throw new Error(
      `Could not confirm the coarse timing peak (global ${signedMs(globalLagMs)}; windows ${windows}). ` +
      'Try another six-second section with clear attacks.',
    );
  }

  const supportLagsMs = support.map((result) => result.lag * ENVELOPE_FRAME_MS);
  const spreadMs = Math.max(...supportLagsMs) - Math.min(...supportLagsMs);
  if (spreadMs > 140) {
    const windows = segmentLagsMs.map(signedMs).join(' / ');
    throw new Error(
      `Timing moved during calibration (global ${signedMs(globalLagMs)}; windows ${windows}). ` +
      'Keep playback continuous and try again.',
    );
  }

  const micLagMs = Math.round(median([
    globalLagMs,
    globalLagMs,
    ...supportLagsMs,
  ]));

  const medianLocalCorrelation = median(support.map((result) => result.correlation));
  const correlationScore = clamp((global.correlation - 0.10) / 0.55, 0, 1);
  const localScore = clamp((medianLocalCorrelation - 0.04) / 0.50, 0, 1);
  const supportScore = support.length / results.length;
  const consistencyScore = clamp(1 - spreadMs / 140, 0, 1);
  const confidence = clamp(
    correlationScore * 0.4 +
    localScore * 0.25 +
    supportScore * 0.2 +
    consistencyScore * 0.15,
    0,
    1,
  );

  return {
    micLagMs,
    confidence,
    segmentLagsMs,
    segmentCorrelations,
    micLevelDbfs,
    backingLevelDbfs,
  };
}
