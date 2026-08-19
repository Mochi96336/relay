import { extractMusicTimingFeatures, type MusicTimingFeatures } from './music-timing-features.js';

export type TimingCalibrationDiagnostics = {
  activeBands: number[];
  supportingBands: number[];
  bestLagMs: number;
  bestScore: number;
  runnerUpLagMs: number | null;
  runnerUpScore: number | null;
  peakMargin: number | null;
  localScores: number[];
};

export type TimingCalibrationAnalysis = {
  micLagMs: number;
  confidence: number;
  segmentLagsMs: number[];
  segmentCorrelations: number[];
  micLevelDbfs: number;
  backingLevelDbfs: number;
  diagnostics: TimingCalibrationDiagnostics;
};

type LagCandidate = {
  lagFrames: number;
  lagMs: number;
  score: number;
};

type LocalLagResult = {
  lagFrames: number;
  score: number;
};

const MAX_LAG_MS = 2_000;
const MINIMUM_GLOBAL_OVERLAP_MS = 3_000;
const LOCAL_SEARCH_RADIUS_MS = 150;
const LOCAL_SUPPORT_RADIUS_MS = 100;
const SEGMENT_LENGTH_MS = 650;
const SEGMENT_COUNT: number = 5;
const SEGMENT_EDGE_MARGIN_MS = 120;
const MIN_GLOBAL_SCORE = 0.18;
const MIN_DISTINCT_PEAK_MARGIN = 0.05;
const MIN_ACTIVE_BANDS = 3;
const MIN_SUPPORTING_BANDS = 3;
const MIN_SUPPORTING_BAND_SCORE = 0.12;
const MIN_LOCAL_SCORE = 0.04;
const DISTINCT_PEAK_RADIUS_MS = 100;
const PREFERRED_LAG_MS = 300;
const PREFERRED_LAG_CORRELATION_MARGIN = 0.08;
const ENERGY_WEIGHT = 0.4;
const FLUX_WEIGHT = 0.6;

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

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizedChannelCorrelation(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  channel: number,
  start: number,
  length: number,
  lagFrames: number,
) {
  const backingOffset = channel * backing.frameCount;
  const micOffset = channel * mic.frameCount;
  let sumBacking = 0;
  let sumMic = 0;
  for (let i = 0; i < length; i += 1) {
    sumBacking += backing.values[backingOffset + start + i];
    sumMic += mic.values[micOffset + start + i + lagFrames];
  }
  const backingMean = sumBacking / length;
  const micMean = sumMic / length;
  let covariance = 0;
  let backingVariance = 0;
  let micVariance = 0;
  for (let i = 0; i < length; i += 1) {
    const backingValue = backing.values[backingOffset + start + i] - backingMean;
    const micValue = mic.values[micOffset + start + i + lagFrames] - micMean;
    covariance += backingValue * micValue;
    backingVariance += backingValue * backingValue;
    micVariance += micValue * micValue;
  }
  const denominator = Math.sqrt(backingVariance * micVariance);
  return denominator > 1e-10 ? covariance / denominator : -1;
}

function bandScoresAtLag(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  activeBands: number[],
  start: number,
  length: number,
  lagFrames: number,
) {
  const scores = new Array<number>(activeBands.length);
  for (let index = 0; index < activeBands.length; index += 1) {
    const band = activeBands[index];
    const energyCorrelation = normalizedChannelCorrelation(backing, mic, band, start, length, lagFrames);
    const fluxCorrelation = normalizedChannelCorrelation(
      backing, mic, backing.bandCount + band, start, length, lagFrames,
    );
    scores[index] = energyCorrelation * ENERGY_WEIGHT + fluxCorrelation * FLUX_WEIGHT;
  }
  return scores;
}

function scoreLag(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  activeBands: number[],
  start: number,
  length: number,
  lagFrames: number,
) {
  return median(bandScoresAtLag(backing, mic, activeBands, start, length, lagFrames));
}

function scoreLagDetailed(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  activeBands: number[],
  start: number,
  length: number,
  lagFrames: number,
) {
  const bandScores = bandScoresAtLag(backing, mic, activeBands, start, length, lagFrames);
  return {
    score: median(bandScores),
    bandScores,
    supportingBands: activeBands.filter((_band, index) => bandScores[index] >= MIN_SUPPORTING_BAND_SCORE),
  };
}

function activeBackingBands(features: MusicTimingFeatures) {
  const strongest = Math.max(...features.bandActivity);
  if (!(strongest > 0)) return [];
  const relativeFloor = strongest * 0.12;
  const active: number[] = [];
  for (let band = 0; band < features.bandCount; band += 1) {
    if (features.bandActivity[band] >= relativeFloor) active.push(band);
  }
  return active;
}

function globalLagScan(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  activeBands: number[],
  maxLagFrames: number,
) {
  const minimumOverlapFrames = Math.round(MINIMUM_GLOBAL_OVERLAP_MS / backing.hopMs);
  const candidates: LagCandidate[] = [];
  for (let lagFrames = -maxLagFrames; lagFrames <= maxLagFrames; lagFrames += 1) {
    const start = Math.max(0, -lagFrames);
    const length = Math.min(backing.frameCount - start, mic.frameCount - (start + lagFrames));
    if (length < minimumOverlapFrames) continue;
    candidates.push({
      lagFrames,
      lagMs: lagFrames * backing.hopMs,
      score: scoreLag(backing, mic, activeBands, start, length, lagFrames),
    });
  }
  if (candidates.length === 0) return { best: null, runnerUp: null, preferred: null };
  let best = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index].score > best.score) best = candidates[index];
  }
  const peaks: LagCandidate[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const left = index > 0 ? candidates[index - 1].score : Number.NEGATIVE_INFINITY;
    const right = index + 1 < candidates.length ? candidates[index + 1].score : Number.NEGATIVE_INFINITY;
    if (candidate.score >= left && candidate.score >= right) peaks.push(candidate);
  }
  peaks.sort((a, b) => b.score - a.score);
  const distinctRadiusFrames = Math.round(DISTINCT_PEAK_RADIUS_MS / backing.hopMs);
  const runnerUp = peaks.find(
    (candidate) => Math.abs(candidate.lagFrames - best.lagFrames) > distinctRadiusFrames,
  ) ?? null;
  const preferredRadiusFrames = Math.round(PREFERRED_LAG_MS / backing.hopMs);
  let preferred: LagCandidate | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.lagFrames) > preferredRadiusFrames) continue;
    if (preferred === null || candidate.score > preferred.score) preferred = candidate;
  }
  return { best, runnerUp, preferred };
}

function bestLocalLag(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  activeBands: number[],
  start: number,
  length: number,
  minLagFrames: number,
  maxLagFrames: number,
): LocalLagResult {
  let bestLagFrames = 0;
  let bestScore = -1;
  for (let lagFrames = minLagFrames; lagFrames <= maxLagFrames; lagFrames += 1) {
    const micStart = start + lagFrames;
    if (micStart < 0 || micStart + length > mic.frameCount) continue;
    const score = scoreLag(backing, mic, activeBands, start, length, lagFrames);
    if (score > bestScore) {
      bestScore = score;
      bestLagFrames = lagFrames;
    }
  }
  return { lagFrames: bestLagFrames, score: bestScore };
}

function validationStarts(
  frameCount: number,
  segmentLength: number,
  minLagFrames: number,
  maxLagFrames: number,
  hopMs: number,
) {
  let first = Math.max(0, -minLagFrames);
  let last = Math.min(frameCount - segmentLength, frameCount - segmentLength - maxLagFrames);
  const margin = Math.round(SEGMENT_EDGE_MARGIN_MS / hopMs);
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

function signedMs(value: number) {
  const rounded = Math.round(value);
  return `${rounded > 0 ? '+' : ''}${rounded} ms`;
}

export function analyzeTimingCalibration(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
  maxLagMs: number = MAX_LAG_MS,
): TimingCalibrationAnalysis {
  if (sampleRate <= 0) throw new Error('Invalid calibration sample rate.');
  const requiredSamples = Math.round(sampleRate * 6);
  if (micSamples.length < requiredSamples || backingSamples.length < requiredSamples) {
    throw new Error('Calibration needs six seconds from both microphone and backing.');
  }
  const micPcm = micSamples.subarray(0, requiredSamples);
  const backingPcm = backingSamples.subarray(0, requiredSamples);
  const micLevelDbfs = levelDbfs(micPcm);
  const backingLevelDbfs = levelDbfs(backingPcm);
  if (backingLevelDbfs < -50) throw new Error('Desktop source is too quiet for timing calibration.');
  if (micLevelDbfs < -60) {
    throw new Error('Phone speaker bleed is too quiet. Raise phone volume and try again.');
  }

  const mic = extractMusicTimingFeatures(micPcm, sampleRate);
  const backing = extractMusicTimingFeatures(backingPcm, sampleRate);
  const activeBands = activeBackingBands(backing);
  if (activeBands.length < MIN_ACTIVE_BANDS) {
    throw new Error(
      'Calibration music has too little spectral activity. Keep playback running and try another section.',
    );
  }

  const maxLagFrames = Math.max(1, Math.round(maxLagMs / backing.hopMs));
  const { best: globalBest, runnerUp, preferred } = globalLagScan(backing, mic, activeBands, maxLagFrames);
  if (!globalBest || globalBest.score < MIN_GLOBAL_SCORE) {
    throw new Error(
      'Calibration signal is weak or does not match the backing track. ' +
      'Use a louder section with clear drums or attacks and try again.',
    );
  }
  const best = preferred !== null
    && preferred.score >= globalBest.score - PREFERRED_LAG_CORRELATION_MARGIN
    ? preferred
    : globalBest;
  const peakMargin = runnerUp === null ? null : globalBest.score - runnerUp.score;
  const globalStart = Math.max(0, -best.lagFrames);
  const globalLength = Math.min(
    backing.frameCount - globalStart,
    mic.frameCount - (globalStart + best.lagFrames),
  );
  const globalDetail = scoreLagDetailed(backing, mic, activeBands, globalStart, globalLength, best.lagFrames);

  const localRadiusFrames = Math.round(LOCAL_SEARCH_RADIUS_MS / backing.hopMs);
  const supportRadiusFrames = Math.round(LOCAL_SUPPORT_RADIUS_MS / backing.hopMs);
  const minLocalLag = Math.max(-maxLagFrames, best.lagFrames - localRadiusFrames);
  const maxLocalLag = Math.min(maxLagFrames, best.lagFrames + localRadiusFrames);
  const segmentLength = Math.round(SEGMENT_LENGTH_MS / backing.hopMs);
  const starts = validationStarts(
    backing.frameCount, segmentLength, minLocalLag, maxLocalLag, backing.hopMs,
  );
  if (starts.length < 3) throw new Error('Not enough overlapping audio to validate this timing result.');
  const results = starts.map((start) => bestLocalLag(
    backing, mic, activeBands, start, segmentLength, minLocalLag, maxLocalLag,
  ));
  const segmentLagsMs = results.map((result) => result.lagFrames * backing.hopMs);
  const segmentCorrelations = results.map((result) => result.score);
  const support = results.filter((result) => (
    result.score >= MIN_LOCAL_SCORE
    && Math.abs(result.lagFrames - best.lagFrames) <= supportRadiusFrames
  ));
  if (support.length < 3) {
    const windows = segmentLagsMs.map(signedMs).join(' / ');
    throw new Error(
      `Could not confirm the coarse timing peak (global ${signedMs(best.lagMs)}; windows ${windows}). ` +
      'Try another six-second section with clear attacks.',
    );
  }
  const supportLagsMs = support.map((result) => result.lagFrames * backing.hopMs);
  const spreadMs = Math.max(...supportLagsMs) - Math.min(...supportLagsMs);
  if (spreadMs > 140) {
    const windows = segmentLagsMs.map(signedMs).join(' / ');
    throw new Error(
      `Timing moved during calibration (global ${signedMs(best.lagMs)}; windows ${windows}). ` +
      'Keep playback continuous and try again.',
    );
  }
  const micLagMs = Math.round(median([best.lagMs, best.lagMs, ...supportLagsMs]));
  const strengthScore = clamp((best.score - MIN_GLOBAL_SCORE) / 0.55, 0, 1);
  const uniquenessScore = peakMargin === null
    ? 1
    : clamp((peakMargin - MIN_DISTINCT_PEAK_MARGIN) / 0.30, 0, 1);
  const bandSupportScore = globalDetail.supportingBands.length / activeBands.length;
  const consistencyScore = clamp(1 - spreadMs / 140, 0, 1);
  const confidence = clamp(
    strengthScore * 0.30 + uniquenessScore * 0.30 + bandSupportScore * 0.20 + consistencyScore * 0.20,
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
    diagnostics: {
      activeBands,
      supportingBands: globalDetail.supportingBands,
      bestLagMs: best.lagMs,
      bestScore: best.score,
      runnerUpLagMs: runnerUp?.lagMs ?? null,
      runnerUpScore: runnerUp?.score ?? null,
      peakMargin,
      localScores: segmentCorrelations,
    },
  };
}
