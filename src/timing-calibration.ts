export type TimingCalibrationAnalysis = {
  micLagMs: number;
  confidence: number;
  segmentLagsMs: number[];
  segmentCorrelations: number[];
  micLevelDbfs: number;
  backingLevelDbfs: number;
};

const ENVELOPE_FRAME_MS = 5;
const MAX_LAG_MS = 650;
const SEGMENT_LENGTH_MS = 1_400;
const SEGMENT_STARTS_MS = [700, 2_300, 3_900];
const LOCAL_MEAN_RADIUS_MS = 125;

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

  // Remove slow loudness changes. What remains is the short-term musical
  // envelope, which survives phone speaker / microphone coloration much better
  // than raw waveform correlation.
  const radius = Math.max(1, Math.round(LOCAL_MEAN_RADIUS_MS / ENVELOPE_FRAME_MS));
  const prefix = new Float64Array(frameCount + 1);
  for (let i = 0; i < frameCount; i += 1) prefix[i + 1] = prefix[i] + energy[i];

  const feature = new Float64Array(frameCount);
  for (let i = 0; i < frameCount; i += 1) {
    const from = Math.max(0, i - radius);
    const to = Math.min(frameCount, i + radius + 1);
    const mean = (prefix[to] - prefix[from]) / Math.max(1, to - from);
    feature[i] = energy[i] - mean;
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
  maxLagFrames: number,
) {
  let bestLag = 0;
  let bestCorrelation = -1;

  for (let lag = -maxLagFrames; lag <= maxLagFrames; lag += 1) {
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

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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
  const segmentLength = Math.round(SEGMENT_LENGTH_MS / ENVELOPE_FRAME_MS);
  const segmentStarts = SEGMENT_STARTS_MS.map((ms) => Math.round(ms / ENVELOPE_FRAME_MS));

  const results = segmentStarts.map((start) => bestLagForSegment(
    backingFeature,
    micFeature,
    start,
    segmentLength,
    maxLagFrames,
  ));

  const segmentLagsMs = results.map((result) => result.lag * ENVELOPE_FRAME_MS);
  const segmentCorrelations = results.map((result) => result.correlation);
  const micLagMs = Math.round(median(segmentLagsMs));
  const medianCorrelation = median(segmentCorrelations);
  const spreadMs = Math.max(...segmentLagsMs) - Math.min(...segmentLagsMs);

  if (medianCorrelation < 0.22) {
    throw new Error('Calibration signal is ambiguous. Keep the room quiet and try a louder music section.');
  }
  if (spreadMs > 120) {
    throw new Error('Calibration windows disagree. Keep the phone still and try another six-second section.');
  }

  const correlationScore = clamp((medianCorrelation - 0.18) / 0.62, 0, 1);
  const consistencyScore = clamp(1 - spreadMs / 120, 0, 1);
  const confidence = clamp(correlationScore * 0.7 + consistencyScore * 0.3, 0, 1);

  return {
    micLagMs,
    confidence,
    segmentLagsMs,
    segmentCorrelations,
    micLevelDbfs,
    backingLevelDbfs,
  };
}
