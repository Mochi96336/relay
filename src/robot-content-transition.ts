import { extractMusicTimingFeatures, type MusicTimingFeatures } from './music-timing-features.js';

export type RobotContentTransitionAnchor = {
  rawLagMs: number;
  score: number;
  peakMargin: number | null;
  supportingBands: number;
};

export type RobotContentTransitionVerdict = 'pre' | 'post' | 'ambiguous';

export type RobotContentTransitionComparison = {
  verdict: RobotContentTransitionVerdict;
  preScore: number | null;
  postScore: number | null;
  preSupportingBands: number;
  postSupportingBands: number;
};

const ENERGY_WEIGHT = 0.4;
const FLUX_WEIGHT = 0.6;
const MIN_ACTIVE_BANDS = 3;
const MIN_SUPPORTING_BANDS = 3;
const MIN_SUPPORTING_BAND_SCORE = 0.12;
const ANCHOR_MIN_SCORE = 0.18;
const ANCHOR_MIN_PEAK_MARGIN = 0.05;
const ANCHOR_DISTINCT_PEAK_RADIUS_MS = 100;
const ANCHOR_MIN_OVERLAP_MS = 900;
const HYPOTHESIS_MIN_SCORE = 0.10;
const HYPOTHESIS_MIN_MARGIN = 0.07;

function median(values: number[]) {
  if (values.length === 0) return Number.NEGATIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
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

function normalizedChannelCorrelation(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  channel: number,
  backingStart: number,
  micStart: number,
  length: number,
) {
  const backingOffset = channel * backing.frameCount + backingStart;
  const micOffset = channel * mic.frameCount + micStart;
  let sumBacking = 0;
  let sumMic = 0;
  let sumBackingSquares = 0;
  let sumMicSquares = 0;
  let sumProducts = 0;

  for (let index = 0; index < length; index += 1) {
    const backingValue = backing.values[backingOffset + index];
    const micValue = mic.values[micOffset + index];
    sumBacking += backingValue;
    sumMic += micValue;
    sumBackingSquares += backingValue * backingValue;
    sumMicSquares += micValue * micValue;
    sumProducts += backingValue * micValue;
  }

  const covariance = sumProducts - (sumBacking * sumMic) / length;
  const backingVariance = sumBackingSquares - (sumBacking * sumBacking) / length;
  const micVariance = sumMicSquares - (sumMic * sumMic) / length;
  const denominator = Math.sqrt(Math.max(0, backingVariance) * Math.max(0, micVariance));
  return denominator > 1e-10 ? covariance / denominator : -1;
}

function bandScore(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  band: number,
  backingStart: number,
  micStart: number,
  length: number,
) {
  const energy = normalizedChannelCorrelation(
    backing, mic, band, backingStart, micStart, length,
  );
  const flux = normalizedChannelCorrelation(
    backing, mic, backing.bandCount + band, backingStart, micStart, length,
  );
  return energy * ENERGY_WEIGHT + flux * FLUX_WEIGHT;
}

function scoreOverlap(
  backing: MusicTimingFeatures,
  mic: MusicTimingFeatures,
  activeBands: number[],
  backingStart: number,
  micStart: number,
  length: number,
) {
  const bandScores = activeBands.map((band) => bandScore(
    backing, mic, band, backingStart, micStart, length,
  ));
  return {
    score: median(bandScores),
    supportingBands: bandScores.filter((score) => score >= MIN_SUPPORTING_BAND_SCORE).length,
  };
}

/**
 * Estimates the stable raw Mic-vs-backing lag immediately before a follower seek.
 *
 * This is deliberately NON-AUTHORITATIVE. It exists only to name the two content
 * hypotheses used to decide when queued pre-seek audio has drained. Failure or
 * ambiguity must keep post-seek content quarantined; this result can never be
 * promoted as calibration or applied to the mixer.
 */
export function estimateRobotContentRawLag(
  micSamples: Int16Array,
  backingSamples: Int16Array,
  sampleRate: number,
  maxLagMs: number,
): RobotContentTransitionAnchor | null {
  if (
    !Number.isFinite(sampleRate)
    || sampleRate <= 0
    || !Number.isFinite(maxLagMs)
    || maxLagMs <= 0
    || micSamples.length === 0
    || backingSamples.length === 0
  ) return null;

  const mic = extractMusicTimingFeatures(micSamples, sampleRate);
  const backing = extractMusicTimingFeatures(backingSamples, sampleRate);
  if (mic.frameCount === 0 || backing.frameCount === 0) return null;
  const activeBands = activeBackingBands(backing);

  const maxLagFrames = Math.max(1, Math.round(maxLagMs / backing.hopMs));
  const minimumOverlapFrames = Math.max(1, Math.round(ANCHOR_MIN_OVERLAP_MS / backing.hopMs));
  const candidates: Array<{ lagFrames: number; score: number; supportingBands: number }> = [];

  for (let lagFrames = -maxLagFrames; lagFrames <= maxLagFrames; lagFrames += 1) {
    const backingStart = Math.max(0, -lagFrames);
    const micStart = Math.max(0, lagFrames);
    const length = Math.min(
      backing.frameCount - backingStart,
      mic.frameCount - micStart,
    );
    if (length < minimumOverlapFrames) continue;
    const scored = scoreOverlap(backing, mic, activeBands, backingStart, micStart, length);
    candidates.push({ lagFrames, ...scored });
  }

  let best = candidates[0];
  for (let index = 1; index < candidates.length; index += 1) {
    if (candidates[index].score > best.score) best = candidates[index];
  }

  const distinctRadius = Math.max(1, Math.round(
    ANCHOR_DISTINCT_PEAK_RADIUS_MS / backing.hopMs,
  ));
  let runnerUp: typeof best | null = null;
  for (const candidate of candidates) {
    if (Math.abs(candidate.lagFrames - best.lagFrames) <= distinctRadius) continue;
    if (runnerUp === null || candidate.score > runnerUp.score) runnerUp = candidate;
  }
  const peakMargin = runnerUp === null ? null : best.score - runnerUp.score;

  if (
    best.score < ANCHOR_MIN_SCORE
    || best.supportingBands < MIN_SUPPORTING_BANDS
    || (peakMargin !== null && peakMargin < ANCHOR_MIN_PEAK_MARGIN)
  ) return null;

  return {
    rawLagMs: best.lagFrames * backing.hopMs,
    score: best.score,
    peakMargin,
    supportingBands: best.supportingBands,
  };
}

function scoreAlignedWindow(
  backingSamples: Int16Array,
  micSamples: Int16Array,
  sampleRate: number,
) {
  if (backingSamples.length === 0 || micSamples.length === 0) return null;
  const backing = extractMusicTimingFeatures(backingSamples, sampleRate);
  const mic = extractMusicTimingFeatures(micSamples, sampleRate);
  const length = Math.min(backing.frameCount, mic.frameCount);
  if (length <= 0) return null;
  const activeBands = activeBackingBands(backing);
  if (activeBands.length < MIN_ACTIVE_BANDS) return null;
  return scoreOverlap(backing, mic, activeBands, 0, 0, length);
}

/**
 * Compares exactly two already-aligned hypotheses for one raw backing window.
 *
 * The caller reads `preMic` at the pre-seek raw lag and `postMic` at the current
 * post-seek raw lag. No global lag is discovered here, so this cannot become a
 * second calibration mechanism. A weak or close result is deliberately
 * ambiguous and must leave the content boundary uncommitted.
 */
export function compareRobotContentHypotheses(
  backingSamples: Int16Array,
  preMicSamples: Int16Array,
  postMicSamples: Int16Array,
  sampleRate: number,
): RobotContentTransitionComparison {
  const pre = scoreAlignedWindow(backingSamples, preMicSamples, sampleRate);
  const post = scoreAlignedWindow(backingSamples, postMicSamples, sampleRate);
  const preScore = pre?.score ?? null;
  const postScore = post?.score ?? null;
  const preSupportingBands = pre?.supportingBands ?? 0;
  const postSupportingBands = post?.supportingBands ?? 0;

  const postWins = postScore !== null
    && postScore >= HYPOTHESIS_MIN_SCORE
    && postSupportingBands >= MIN_SUPPORTING_BANDS
    && (preScore === null || postScore - preScore >= HYPOTHESIS_MIN_MARGIN);
  const preWins = preScore !== null
    && preScore >= HYPOTHESIS_MIN_SCORE
    && preSupportingBands >= MIN_SUPPORTING_BANDS
    && (postScore === null || preScore - postScore >= HYPOTHESIS_MIN_MARGIN);

  return {
    verdict: postWins ? 'post' : preWins ? 'pre' : 'ambiguous',
    preScore,
    postScore,
    preSupportingBands,
    postSupportingBands,
  };
}
