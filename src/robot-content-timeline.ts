import { mediaToWallMs } from './boot-calibration.js';
import type { CalibrationContext } from './calibration-session.js';

function sameContext(left: CalibrationContext, right: CalibrationContext) {
  return left.sessionGeneration === right.sessionGeneration
    && left.micGeneration === right.micGeneration
    && left.backingGeneration === right.backingGeneration
    && left.sourceGeneration === right.sourceGeneration;
}

/**
 * Keeps Robot content-correlation evidence in one stable media-time frame.
 *
 * Relay capture sample positions keep advancing across `player.seekTo()`,
 * while the YouTube content position does not. The Robot's player delta is
 * therefore part of the mapping from backing capture samples to song time,
 * not a permanent acoustic path property.
 *
 * Player deltas are *media* time - the Robot subtracts two `currentTime`
 * readings - while capture sample positions advance in wall time. The room's
 * playback rate is the conversion between them, so a mapping is only meaningful
 * alongside the rate it was built at. The rate is bound with the context for
 * that reason: a rate change is a mapping discontinuity, and the server revokes
 * on one rather than silently reinterpreting old deltas at a new rate.
 *
 * The first authoritative player delta in a CalibrationContext becomes the
 * reference frame. Player control may observe a new delta before Browser ->
 * PipeWire -> parec has emitted the corresponding music. Keep that observed
 * delta separate from the delta whose backing CONTENT has actually reached the
 * capture stream. Only the committed content delta may move media coordinates
 * or the live mixer read head.
 */
export class RobotContentTimelineMapper {
  private readonly sampleRate: number;
  private readonly freshForMs: number;
  private contextValue: CalibrationContext | null = null;
  private referenceDeltaMsValue: number | null = null;
  /** Latest player/control mapping, including an uncommitted follower seek. */
  private observedDeltaMsValue: number | null = null;
  /** Mapping proven to have reached backing PCM and therefore safe for live audio. */
  private committedDeltaMsValue: number | null = null;
  private lastMappedAtMs = Number.NEGATIVE_INFINITY;
  private awaitingBackingBoundaryValue = false;
  private minimumBackingSampleValue: number | null = null;
  /** The rate the bound mapping's media/wall conversion assumes. */
  private playbackRateValue = 1;

  constructor(options: { sampleRate: number; freshForMs: number }) {
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
      throw new Error('sampleRate must be positive.');
    }
    if (!Number.isFinite(options.freshForMs) || options.freshForMs <= 0) {
      throw new Error('freshForMs must be positive.');
    }
    this.sampleRate = options.sampleRate;
    this.freshForMs = options.freshForMs;
  }

  reset() {
    this.contextValue = null;
    this.referenceDeltaMsValue = null;
    this.observedDeltaMsValue = null;
    this.committedDeltaMsValue = null;
    this.lastMappedAtMs = Number.NEGATIVE_INFINITY;
    this.awaitingBackingBoundaryValue = false;
    this.minimumBackingSampleValue = null;
    this.playbackRateValue = 1;
  }

  /** Records the smoothed live Robot error: player media time - room target. */
  notePlayerOffset(
    deltaMs: number,
    context: CalibrationContext,
    nowMs: number,
    playbackRate = 1,
  ) {
    if (!Number.isFinite(deltaMs) || !Number.isFinite(nowMs)) return false;
    this.bindContext(context);
    if (this.referenceDeltaMsValue === null) {
      // The reference frame and the rate that reads it are one fact.
      this.bindPlaybackRate(playbackRate);
      this.referenceDeltaMsValue = deltaMs;
      this.committedDeltaMsValue = deltaMs;
    }
    this.observedDeltaMsValue = deltaMs;
    // Ordinary player-offset updates retain the existing behaviour. During a
    // follower seek, however, control can settle before the old music drains
    // from PipeWire. Hold live/content authority on the pre-seek delta until
    // the PCM transition verifier commits the new backing segment.
    if (!this.awaitingBackingBoundaryValue) this.committedDeltaMsValue = deltaMs;
    this.lastMappedAtMs = nowMs;
    return true;
  }

  /**
   * Records a real follower `seekTo(target)` mapping break.
   *
   * `fromMediaTime` is the player position immediately before seek and
   * `toMediaTime` is the authoritative target passed to seekTo(). Their
   * difference is the concrete media-time jump. Apply that jump only to the
   * observed player mapping. The previously committed backing-content mapping
   * remains live until PCM evidence proves that the new content has crossed the
   * capture pipeline.
   */
  noteFollowerCorrection(
    fromMediaTime: number,
    toMediaTime: number,
    context: CalibrationContext,
    nowMs: number,
  ) {
    if (
      !Number.isFinite(fromMediaTime)
      || !Number.isFinite(toMediaTime)
      || fromMediaTime < 0
      || toMediaTime < 0
      || !Number.isFinite(nowMs)
    ) return false;
    if (
      this.contextValue === null
      || this.referenceDeltaMsValue === null
      || this.observedDeltaMsValue === null
      || this.committedDeltaMsValue === null
      || !sameContext(this.contextValue, context)
    ) return false;

    const seekJumpMs = (toMediaTime - fromMediaTime) * 1_000;
    if (!Number.isFinite(seekJumpMs)) return false;

    this.observedDeltaMsValue += seekJumpMs;
    this.lastMappedAtMs = nowMs;
    this.awaitingBackingBoundaryValue = true;
    this.minimumBackingSampleValue = null;
    return true;
  }

  /** True while content PCM must wait for an ordered frontier from its own socket. */
  needsBackingBoundary(context: CalibrationContext) {
    return this.awaitingBackingBoundaryValue
      && this.contextValue !== null
      && sameContext(this.contextValue, context);
  }

  /**
   * Commits the first raw backing sample that may use the observed post-seek mapping.
   *
   * The server calls this only after its PCM hypothesis verifier has proved that
   * the new music content is present at/after `firstSampleIndex`. Promotion of
   * observed -> committed delta is therefore the single authority boundary for
   * both calibration coordinates and the live mixer.
   */
  noteBackingBoundary(firstSampleIndex: number, context: CalibrationContext, nowMs: number) {
    if (
      !Number.isSafeInteger(firstSampleIndex)
      || firstSampleIndex < 0
      || !this.awaitingBackingBoundaryValue
      || this.contextValue === null
      || !sameContext(this.contextValue, context)
      || !this.isReady(context, nowMs)
    ) return false;

    this.awaitingBackingBoundaryValue = false;
    this.minimumBackingSampleValue = firstSampleIndex;
    this.committedDeltaMsValue = this.observedDeltaMsValue;
    return true;
  }

  isReady(context: CalibrationContext, nowMs: number) {
    return this.contextValue !== null
      && this.referenceDeltaMsValue !== null
      && this.observedDeltaMsValue !== null
      && this.committedDeltaMsValue !== null
      && sameContext(this.contextValue, context)
      && Number.isFinite(nowMs)
      && nowMs - this.lastMappedAtMs <= this.freshForMs;
  }

  /** Maps Robot backing capture onto the stable reference using committed content only. */
  mapBackingStart(startSample: number, context: CalibrationContext, nowMs: number) {
    if (!Number.isSafeInteger(startSample) || !this.isReady(context, nowMs)) return null;
    if (this.awaitingBackingBoundaryValue) return null;
    if (this.minimumBackingSampleValue !== null && startSample < this.minimumBackingSampleValue) return null;
    const shiftSamples = Math.round(
      (this.mappingShiftWallMs() * this.sampleRate) / 1_000,
    );
    const mapped = startSample + shiftSamples;
    return Number.isSafeInteger(mapped) ? mapped : null;
  }

  /** Converts reference-frame authority using the delta proven to be in backing PCM. */
  liveLagMs(referenceLagMs: number, context: CalibrationContext, nowMs: number) {
    if (!Number.isFinite(referenceLagMs) || !this.isReady(context, nowMs)) return null;
    return referenceLagMs + this.mappingShiftWallMs();
  }

  /**
   * How far committed content sits from the reference frame, in wall time.
   *
   * The deltas are media milliseconds; capture samples and the mixer read head
   * are wall time. Converting here is what keeps a 2x room from being aligned
   * as if its player error were twice the real audio offset.
   */
  private mappingShiftWallMs() {
    return mediaToWallMs(
      this.committedDeltaMsValue! - this.referenceDeltaMsValue!,
      this.playbackRateValue,
    );
  }

  /** The rate this mapping converts media deltas at. */
  get playbackRate() {
    return this.playbackRateValue;
  }

  /**
   * Whether an existing mapping still describes the room's current rate.
   *
   * False is a mapping discontinuity, not a recoverable disagreement: every
   * delta already folded into the reference frame was converted at the old
   * rate, so nothing here can be reinterpreted in place.
   */
  matchesPlaybackRate(playbackRate: number) {
    if (this.contextValue === null || this.referenceDeltaMsValue === null) return true;
    if (!Number.isFinite(playbackRate) || playbackRate <= 0) return true;
    return Math.abs(this.playbackRateValue - playbackRate) <= 0.0001;
  }

  get referenceDeltaMs() {
    return this.referenceDeltaMsValue;
  }

  /** Latest player/control mapping; may be ahead of backing PCM during a seek. */
  get currentDeltaMs() {
    return this.observedDeltaMsValue;
  }

  /** Delta whose music content has been proven to have reached backing PCM. */
  get committedDeltaMs() {
    return this.committedDeltaMsValue;
  }

  private bindPlaybackRate(playbackRate: number) {
    this.playbackRateValue = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
  }

  private bindContext(context: CalibrationContext) {
    if (this.contextValue !== null && sameContext(this.contextValue, context)) return;
    this.reset();
    this.contextValue = { ...context };
  }
}
