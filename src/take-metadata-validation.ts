import type { TakeQualityAssessment } from './take-quality.js';
import type { TakeSongSnapshot, TakeStopReason } from './take-session.js';

const TAKE_STOP_REASONS = new Set<TakeStopReason>([
  'user',
  'mix-ended',
  'server-shutdown',
]);

const TAKE_QUALITY_POLICY_VERSIONS = new Set([
  'take-quality-v1',
  'take-quality-v2',
  'take-quality-v3',
  'take-quality-v4',
]);

const TAKE_QUALITY_VERDICTS = new Set(['clean', 'review', 'degraded']);
const TAKE_QUALITY_SEVERITIES = new Set(['warning', 'critical']);
const TAKE_QUALITY_UNITS = new Set(['ms', 'samples', 'events', 'boolean']);

const TAKE_QUALITY_EVENT_KINDS = [
  'mic-transport-disconnected',
  'mic-transport-connected',
  'mic-capture-restarted',
  'backing-transport-disconnected',
  'backing-transport-connected',
  'backing-transport-replaced',
  'backing-capture-restarted',
  'robot-source-disconnected',
  'robot-source-connected',
  'robot-source-replaced',
  'mic-owner-changed',
  'server-shutdown',
] as const;

const TAKE_QUALITY_V1_ISSUE_CODES = new Set([
  'mic-unavailable',
  'backing-unavailable',
  'mic-pcm-gap',
  'backing-pcm-gap',
  'mic-starvation',
  'backing-starvation',
  'output-clipping',
  'unheadered-pcm',
  'timing-fallback',
  'calibration-stale',
  'alignment-clamped',
  'robot-delta-missing',
  'transport-instability',
  'recording-interrupted',
]);
const TAKE_QUALITY_V2_ISSUE_CODES = new Set([
  ...TAKE_QUALITY_V1_ISSUE_CODES,
  'timing-diverged',
]);
const TAKE_QUALITY_V4_ISSUE_CODES = new Set([
  ...TAKE_QUALITY_V2_ISSUE_CODES,
  'mic-input-clipping',
]);

const BASE_SAMPLE_FIELDS = [
  'recordedSamples',
  'micGapSamples',
  'backingGapSamples',
  'micStarvedFrames',
  'backingStarvedFrames',
  'micStarvedSamples',
  'backingStarvedSamples',
  'clippedSamples',
  'limitedSamples',
  'unheaderedSamples',
  'micUnavailableSamples',
  'backingUnavailableSamples',
  'networkEstimateSamples',
  'calibrationStaleSamples',
  'alignmentClampedSamples',
  'robotDeltaMissingSamples',
] as const;

const BASE_DURATION_FIELDS = [
  'recordedDurationMs',
  'micGapMs',
  'backingGapMs',
  'micStarvedMs',
  'backingStarvedMs',
  'clippedMs',
  'limitedMs',
  'micUnavailableMs',
  'backingUnavailableMs',
  'networkEstimateMs',
  'calibrationStaleMs',
  'alignmentClampedMs',
  'robotDeltaMissingMs',
] as const;

function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function nonNegativeFinite(value: unknown) {
  return finiteNumber(value) && value >= 0;
}

function positiveFinite(value: unknown) {
  return finiteNumber(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function positiveSafeInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function nullableFinite(value: unknown) {
  return value === null || finiteNumber(value);
}

function isTakeSongSnapshot(value: unknown): value is TakeSongSnapshot {
  const song = recordValue(value);
  if (!song) return false;
  if (song.videoId !== null && typeof song.videoId !== 'string') return false;
  if (!nullableFinite(song.revision)) return false;
  if (!nullableFinite(song.state)) return false;
  if (!nullableFinite(song.serverTime)) return false;
  return nullableFinite(song.playbackRate);
}

function isTakeQualityEvidence(value: unknown, policyVersion: string) {
  const evidence = recordValue(value);
  if (!evidence) return false;
  if (!positiveSafeInteger(evidence.sampleRate)) return false;
  for (const field of BASE_SAMPLE_FIELDS) {
    if (!nonNegativeSafeInteger(evidence[field])) return false;
  }
  for (const field of BASE_DURATION_FIELDS) {
    if (!nonNegativeFinite(evidence[field])) return false;
  }
  if (typeof evidence.unheadered !== 'boolean') return false;

  const events = recordValue(evidence.events);
  if (!events) return false;
  for (const kind of TAKE_QUALITY_EVENT_KINDS) {
    if (!nonNegativeSafeInteger(events[kind])) return false;
  }

  if (
    policyVersion === 'take-quality-v2'
    || policyVersion === 'take-quality-v3'
    || policyVersion === 'take-quality-v4'
  ) {
    if (!nonNegativeSafeInteger(evidence.timingDivergedSamples)) return false;
    if (!nonNegativeFinite(evidence.timingDivergedMs)) return false;
    if (!nonNegativeFinite(evidence.peakTimingDivergenceMs)) return false;
  }
  if (policyVersion === 'take-quality-v3' || policyVersion === 'take-quality-v4') {
    if (!positiveFinite(evidence.timingDivergenceToleranceMs)) return false;
    if (
      evidence.recordingInterrupted !== undefined
      && typeof evidence.recordingInterrupted !== 'boolean'
    ) return false;
  }
  if (policyVersion === 'take-quality-v4') {
    if (!nonNegativeSafeInteger(evidence.micInputClippedSamples)) return false;
    if (!nonNegativeFinite(evidence.micInputClippedMs)) return false;
  }
  return true;
}

function isTakeQualityIssue(value: unknown, policyVersion: string) {
  const issue = recordValue(value);
  if (!issue) return false;
  const allowedCodes = policyVersion === 'take-quality-v1'
    ? TAKE_QUALITY_V1_ISSUE_CODES
    : policyVersion === 'take-quality-v4'
      ? TAKE_QUALITY_V4_ISSUE_CODES
      : TAKE_QUALITY_V2_ISSUE_CODES;
  if (typeof issue.code !== 'string' || !allowedCodes.has(issue.code)) return false;
  if (typeof issue.severity !== 'string' || !TAKE_QUALITY_SEVERITIES.has(issue.severity)) return false;
  if (typeof issue.unit !== 'string' || !TAKE_QUALITY_UNITS.has(issue.unit)) return false;
  if (typeof issue.message !== 'string') return false;
  if (issue.unit === 'boolean') return typeof issue.value === 'boolean';
  return nonNegativeFinite(issue.value);
}

function isStoredTakeQualityAssessment(value: unknown): value is TakeQualityAssessment {
  const quality = recordValue(value);
  if (!quality) return false;
  if (
    typeof quality.policyVersion !== 'string'
    || !TAKE_QUALITY_POLICY_VERSIONS.has(quality.policyVersion)
  ) return false;
  if (typeof quality.verdict !== 'string' || !TAKE_QUALITY_VERDICTS.has(quality.verdict)) {
    return false;
  }
  if (!isTakeQualityEvidence(quality.evidence, quality.policyVersion)) return false;
  if (!Array.isArray(quality.issues)) return false;
  if (!quality.issues.every((issue) => isTakeQualityIssue(issue, quality.policyVersion as string))) {
    return false;
  }

  const expectedVerdict = quality.issues.some((issue) => {
    const candidate = recordValue(issue);
    return candidate?.severity === 'critical';
  })
    ? 'degraded'
    : quality.issues.length > 0
      ? 'review'
      : 'clean';
  return quality.verdict === expectedVerdict;
}

export type NormalizedPersistedTakeRichFields = {
  stopReason: TakeStopReason | null;
  song: TakeSongSnapshot | null;
  quality: TakeQualityAssessment | null;
  recovered: boolean;
};

/**
 * Validates fields that evolved inside metadata version 1 without forcing old
 * Takes to masquerade as the current schema. Missing legacy fields normalize to
 * the conservative values existing readers already expected; present fields
 * must match the policy/schema version that originally wrote them.
 */
export function normalizePersistedTakeRichFields(
  value: unknown,
): NormalizedPersistedTakeRichFields | null {
  const take = recordValue(value);
  if (!take) return null;

  let stopReason: TakeStopReason | null = null;
  if (take.stopReason !== undefined && take.stopReason !== null) {
    if (typeof take.stopReason !== 'string' || !TAKE_STOP_REASONS.has(take.stopReason as TakeStopReason)) {
      return null;
    }
    stopReason = take.stopReason as TakeStopReason;
  }

  let song: TakeSongSnapshot | null = null;
  if (take.song !== undefined && take.song !== null) {
    if (!isTakeSongSnapshot(take.song)) return null;
    song = { ...take.song };
  }

  let quality: TakeQualityAssessment | null = null;
  if (take.quality !== undefined && take.quality !== null) {
    if (!isStoredTakeQualityAssessment(take.quality)) return null;
    // TakeLibrary's public type predates archival policy-version widening. The
    // runtime validator above preserves v1/v2/v3/v4 verbatim; consumers rely only
    // on the stable verdict/evidence surface and must not re-assess old Takes.
    quality = structuredClone(take.quality) as TakeQualityAssessment;
  }

  let recovered = false;
  if (take.recovered !== undefined) {
    if (typeof take.recovered !== 'boolean') return null;
    recovered = take.recovered;
  }

  return { stopReason, song, quality, recovered };
}
