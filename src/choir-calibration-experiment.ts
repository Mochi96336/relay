import { combineBootCalibration, mediaToWallMs, type BootCalibrationInput } from './boot-calibration.js';
import { SampleSongFallback, type SongSampleAnchor } from './sample-song-fallback.js';
import { analyzeTimingCalibration, type TimingCalibrationResult } from './timing-calibration.js';

/**
 * Isolated Choir calibration experiment. NOT used by server.ts or AudioSession.
 *
 * One real Content analyzer result, one measured Boot path, and one real
 * SampleSongFallback belong to each explicit singer identity. The caller owns
 * admission, freshness, Robot mapping, stream clocks, and mixer application.
 */
export type ChoirCalibrationIdentity = {
  participantId: string;
  videoId: string;
  songEpoch: number;
  micGeneration: number;
  backingGeneration: number;
  roomGeneration: number;
  robotSourceGeneration: number;
  micSourceRate: number;
  backingSourceRate: number;
};

export type ChoirContentCandidate = {
  identity: ChoirCalibrationIdentity;
  result: TimingCalibrationResult;
};

export type ChoirFallbackPreference = 'sample-song' | 'boot-probe';
export type ChoirContentApplicability = 'apply' | 'hold' | 'revoke';
export type ChoirCalibrationSource = 'content' | 'content-held' | 'sample-song-estimate' | 'boot-probe-estimate' | 'unavailable';

export type ChoirAlignmentDecision = {
  source: ChoirCalibrationSource;
  advanceMs: number | null;
  /** Relative to the confirmed Content value, only when Content is applicable. */
  sampleResidualMs: number | null;
  bootResidualMs: number | null;
  sampleCandidateMs: number | null;
  bootCandidateMs: number | null;
};

type BootPath = {
  pathDifferenceMs: number;
  confidence: number;
};

type SingerState = {
  identity: ChoirCalibrationIdentity;
  content: TimingCalibrationResult | null;
  sample: SampleSongFallback;
  boot: BootPath | null;
};

function validEpoch(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validIdentity(identity: ChoirCalibrationIdentity) {
  return identity.participantId.trim().length > 0
    && identity.participantId === identity.participantId.trim()
    && /^[A-Za-z0-9_-]{11}$/.test(identity.videoId)
    && validEpoch(identity.songEpoch)
    && validEpoch(identity.micGeneration)
    && validEpoch(identity.backingGeneration)
    && validEpoch(identity.roomGeneration)
    && validEpoch(identity.robotSourceGeneration)
    && Number.isFinite(identity.micSourceRate) && identity.micSourceRate >= 8_000 && identity.micSourceRate <= 192_000
    && Number.isFinite(identity.backingSourceRate) && identity.backingSourceRate >= 8_000 && identity.backingSourceRate <= 192_000;
}

function sameIdentity(a: ChoirCalibrationIdentity, b: ChoirCalibrationIdentity) {
  return a.participantId === b.participantId
    && a.videoId === b.videoId
    && a.songEpoch === b.songEpoch
    && a.micGeneration === b.micGeneration
    && a.backingGeneration === b.backingGeneration
    && a.roomGeneration === b.roomGeneration
    && a.robotSourceGeneration === b.robotSourceGeneration
    && a.micSourceRate === b.micSourceRate
    && a.backingSourceRate === b.backingSourceRate;
}

export class ChoirCalibrationExperiment {
  private readonly singers = new Map<string, SingerState>();

  /** Only the authoritative coordinator calls activate; stale observations cannot. */
  activate(identity: ChoirCalibrationIdentity): boolean {
    if (!validIdentity(identity)) return false;
    const previous = this.singers.get(identity.participantId);
    if (previous && sameIdentity(previous.identity, identity)) return false;
    this.singers.set(identity.participantId, {
      identity: { ...identity }, content: null, sample: new SampleSongFallback(), boot: null,
    });
    return true;
  }

  remove(participantId: string) {
    return this.singers.delete(participantId);
  }

  private matching(identity: ChoirCalibrationIdentity): SingerState | null {
    const state = this.singers.get(identity.participantId);
    return state && sameIdentity(state.identity, identity) ? state : null;
  }

  /**
   * Runs the actual production Content analyzer. A rejected retry must not
   * erase a previously confirmed result in the same unchanged acoustic epoch.
   * A new epoch instead requires explicit activate(), which clears ALL sources.
   */
  analyzeContent(
    identity: ChoirCalibrationIdentity,
    mic: Int16Array,
    backing: Int16Array,
    sampleRate: number,
    maxLagMs = 2_000,
  ): { status: 'candidate'; candidate: ChoirContentCandidate }
    | { status: 'rejected' | 'stale-identity'; reason: string } {
    const state = this.matching(identity);
    if (!state) return { status: 'stale-identity', reason: 'identity-not-active' };
    try {
      const result = analyzeTimingCalibration(mic, backing, sampleRate, maxLagMs);
      if (!Number.isFinite(result.micLagMs) || !Number.isFinite(result.confidence)) {
        return { status: 'rejected', reason: 'nonfinite-content-result' };
      }
      // Correlation alone does not prove a safe mixer authority. The normal
      // CalibrationSession / validator must accept this candidate explicitly.
      return { status: 'candidate', candidate: { identity: { ...identity }, result } };
    } catch (error) {
      return { status: 'rejected', reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Confirmation is separate from analysis; never promote a raw correlation. */
  confirmContent(candidate: ChoirContentCandidate, externallyAccepted: boolean): boolean {
    const state = this.matching(candidate.identity);
    if (!state || !externallyAccepted
      || !Number.isFinite(candidate.result.micLagMs)
      || !Number.isFinite(candidate.result.confidence)
      || candidate.result.confidence <= 0
      || candidate.result.confidence > 1) return false;
    state.content = candidate.result;
    return true;
  }

  /** Pair each singer's mic observations with shared Robot-side observations. */
  observeSample(
    identity: ChoirCalibrationIdentity,
    side: 'mic' | 'backing',
    anchor: SongSampleAnchor,
    nowMs: number,
  ): boolean {
    const state = this.matching(identity);
    if (!state || anchor.videoId !== identity.videoId
      || anchor.generation !== (side === 'mic' ? identity.micGeneration : identity.backingGeneration)
      || anchor.sampleRate !== (side === 'mic' ? identity.micSourceRate : identity.backingSourceRate)) {
      return false;
    }
    return state.sample.observe(side, anchor, nowMs);
  }

  /**
   * The real Boot arithmetic, but only after the external probe runtime has
   * separately authenticated and accepted BOTH legs. Do not convert raw
   * correlations into proof here or freeze the Robot player delta forever.
   */
  observeBoot(
    identity: ChoirCalibrationIdentity,
    measurement: BootCalibrationInput,
    probeAccepted: boolean,
  ): boolean {
    const state = this.matching(identity);
    if (!state || !probeAccepted
      || !Number.isFinite(measurement.sampleRate) || measurement.sampleRate <= 0
      || !Number.isFinite(measurement.playbackRate) || measurement.playbackRate <= 0
      || !Number.isFinite(measurement.deltaMs)
      || ![measurement.mic, measurement.backing].every((leg) =>
        Number.isSafeInteger(leg.targetSample) && Number.isSafeInteger(leg.actualSample)
        && Number.isFinite(leg.correlation) && leg.correlation > 0 && leg.correlation <= 1)) {
      return false;
    }
    const result = combineBootCalibration(measurement);
    if (!Number.isFinite(result.advanceMs)) return false;
    state.boot = {
      pathDifferenceMs: result.micLatencyMs - result.backingLatencyMs,
      confidence: result.confidence,
    };
    return true;
  }

  resolve(input: {
    identity: ChoirCalibrationIdentity;
    nowMs: number;
    /** Supplied by Robot Content mapping validity; age alone is not a revoke. */
    contentApplicability: ChoirContentApplicability;
    /** The existing sample-index-to-session-coordinate function. */
    sampleMap: (side: 'mic' | 'backing', anchor: SongSampleAnchor) => number | null;
    sessionSampleRate: number;
    /** Boot's player delta must be live and independently proven fresh. */
    freshRobotDeltaMs?: number | null;
    playbackRate: number;
    preference?: ChoirFallbackPreference;
  }): ChoirAlignmentDecision | null {
    const state = this.matching(input.identity);
    if (!state || !Number.isFinite(input.nowMs) || !Number.isFinite(input.sessionSampleRate)
      || input.sessionSampleRate <= 0) return null;
    // 'revoke' is a permanent authority invalidation, not a temporary
    // absence of new Content evidence. No implicit revival on the next query.
    if (input.contentApplicability === 'revoke') state.content = null;
    const sampleCandidateMs = state.sample.estimate(
      input.nowMs, input.identity.videoId, input.sampleMap, input.sessionSampleRate,
    );
    const bootCandidateMs = state.boot && Number.isFinite(input.freshRobotDeltaMs)
      && Number.isFinite(input.playbackRate) && input.playbackRate > 0
      ? state.boot.pathDifferenceMs
        + mediaToWallMs(input.freshRobotDeltaMs!, input.playbackRate)
      : null;

    const content = input.contentApplicability !== 'revoke' ? state.content : null;
    const sampleResidualMs = content && sampleCandidateMs !== null
      ? sampleCandidateMs - content.micLagMs : null;
    const bootResidualMs = content && bootCandidateMs !== null
      ? bootCandidateMs - content.micLagMs : null;
    const diagnostic = { sampleResidualMs, bootResidualMs, sampleCandidateMs, bootCandidateMs };

    if (content) {
      return {
        ...diagnostic,
        source: input.contentApplicability === 'hold' ? 'content-held' : 'content',
        advanceMs: content.micLagMs,
      };
    }

    // No fixed accuracy superiority is assumed: choose explicitly while
    // diagnostics collect device-specific residuals against known Content.
    const preference = input.preference ?? 'sample-song';
    const alternatives: readonly ChoirFallbackPreference[] = preference === 'sample-song'
      ? ['sample-song', 'boot-probe'] : ['boot-probe', 'sample-song'];
    for (const source of alternatives) {
      if (source === 'sample-song' && sampleCandidateMs !== null) {
        return { ...diagnostic, source: 'sample-song-estimate', advanceMs: sampleCandidateMs };
      }
      if (source === 'boot-probe' && bootCandidateMs !== null
        && Number.isFinite(bootCandidateMs) && Math.abs(bootCandidateMs) <= 2_000) {
        return { ...diagnostic, source: 'boot-probe-estimate', advanceMs: bootCandidateMs };
      }
    }
    return { ...diagnostic, source: 'unavailable', advanceMs: null };
  }
}
