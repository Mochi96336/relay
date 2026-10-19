import { performance } from 'node:perf_hooks';
import { ingestPcmTimeline, type PcmIngestResult } from './pcm-ingest.js';

import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import type { PcmFrame } from './pcm-frame.js';
import {
  emptyPcmTimeline,
  readPcmEvidence,
  readPcmGapMask,
  readPcmRange,
  resetPcmTimeline,
  retainsPcmAfter,
  trimPcmTimeline,
  type PcmTimeline,
} from './pcm-timeline.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { MicGainRamp } from './mic-gain-ramp.js';
import { MicLimiter } from './mic-limiter.js';
import { MicRawMeter } from './mic-raw-meter.js';
import { MixBus } from './mix-bus.js';
import { MicTrack, type AlignmentState, type MicReadPlan } from './mic-track.js';
import { SourceOutputEdge } from './source-output-edge.js';
import { declickSourceGap } from './pcm-source-edge-taper.js';

/**
 * Owns the live mix: both PCM timelines, the session clock, the alignment the
 * mixer applies, and the health counters that say when any of it is failing.
 *
 * This state used to be a dozen module-level variables in `server.ts`, which
 * meant transport events reached in and reset the mix clock directly. The
 * session is now told what happened - a source appeared, a frame arrived, an
 * alignment was measured - and decides for itself what that does to the audio.
 */

export type { MicTimelineFold, MicTimelineUnfold } from './mic-frontier-correction.js';
export { HEAVY_LIMIT_DB, LIMITER_THRESHOLD_DBFS } from './mic-limiter.js';

export type { AlignmentState };

/**
 * Raw evidence for exactly one mixed output frame.
 *
 * These values describe what the mixer actually read for the samples it just
 * emitted. They deliberately contain no Take verdict or policy: the audio
 * domain reports facts, while the Take domain decides whether those facts mean
 * clean, review or degraded.
 */
export type MixFrameEvidence = {
  micGapSamples: number;
  backingGapSamples: number;
  micStarvedSamples: number;
  backingStarvedSamples: number;
  micUnavailableSamples: number;
  backingUnavailableSamples: number;
  clippedSamples: number;
  /** Emitted Mic samples derived from a proven raw-input flat-top run. */
  micInputClippedSamples: number;
  limitedSamples: number;
  /** Mic samples held down by more than `HEAVY_LIMIT_DB`: audible, not just protective. */
  heavyLimitedSamples: number;
  unheaderedSamples: number;
  /**
   * The second singer's share of this frame. Present only while a B is
   * attached, so an N=1 frame's evidence is unchanged. Counted only while B
   * is allowed to sound: a B that is still silent cannot damage the Take.
   */
  secondaryAudibleSamples?: number;
  secondaryGapSamples?: number;
  secondaryStarvedSamples?: number;
};

/** Authoritative position of one emitted frame on the shared mix timeline. */
export type MixFramePosition = {
  generation: number;
  firstSampleIndex: number;
};

export type MixHealth = {
  micStarvedFrames: number;
  backingStarvedFrames: number;
  micHeadroomMs: number;
  backingHeadroomMs: number;
  micGapMs: number;
  backingGapMs: number;
  backingClockCorrectionSamples: number;
  /** Samples the summing stage had to clamp, i.e. audible distortion. */
  clippedSamples: number;
  /** Samples the microphone limiter held down. Working, not failing. */
  limitedSamples: number;
  /**
   * The raw microphone over the last few seconds, before any mix gain. Peak is
   * what decides the gain - it is what runs into the limiter - and RMS says
   * whether there is any signal at all. Null until the phone sends something.
   */
  micPeakDbfs: number | null;
  micRmsDbfs: number | null;
  unheadered: boolean;
};

/**
 * Jitter headroom the read-ahead is never allowed to eat. Reading ahead spends
 * prebuffer and reading behind spends retained history, so the advance has to
 * fit between them however large a lag the calibration reports.
 */
const ADVANCE_SAFETY_MS = 200;

/**
 * Runtime validation corrects an already-live read head. Moving it in one frame
 * skips or repeats the whole delta, so validated drift is allowed to change the
 * read rate by at most one percent until the new target is reached. Initial,
 * manual and robot calibrations still use the existing immediate setAlignment.
 */
const RUNTIME_CALIBRATION_SLEW_FRACTION = 0.01;

/**
 * Immediate authority changes must take effect immediately, but changing the
 * Mic read head by tens or hundreds of milliseconds in one sample is a splice.
 * Fade from the previously-emitted trajectory into the new one over only a few
 * milliseconds: long enough to remove the discontinuity, short enough that the
 * timing authority is not audibly delayed.
 */
const MIC_READ_HEAD_CROSSFADE_MS = 5;

/**
 * A real packet hole is silence, but entering or leaving that silence in one
 * sample creates a click that was not present in either source segment.
 * Preserve the hole itself and its evidence; taper only the real source
 * samples immediately adjacent to it.
 */
const SOURCE_GAP_DECLICK_MS = 2;

/** Where a batch of ingested samples landed on the shared session timeline. */
export type IngestResult = PcmIngestResult;

export type AudioSessionOptions = {
  sampleRate: number;
  frameMs: number;
  prebufferMs: number;
  backingGain: number;
  /** How far behind the read head to keep microphone audio before discarding it. */
  retentionMs: number;
  /**
   * The same for the captured song, which the mixer reads at the read head
   * rather than behind it and so needs far less of - but it is not the only
   * reader. A probe calibration looks back over its whole search window, and
   * that window is minutes-old by timeline standards: it cannot be analysed
   * until enough audio has arrived to cover it.
   *
   * This was a hardcoded one second, which was enough only while the backing
   * path was two seconds slow and the probe therefore landed close to the
   * frontier. Bounding the capture latency moved the probe nearly two seconds
   * further back, straight into the discarded region, and the probe leg began
   * correlating at exactly -1 against a window of zeros.
   */
  backingRetentionMs?: number;
};

export class AudioSession {
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly frameSamples: number;
  readonly prebufferMs: number;
  readonly retentionMs: number;
  readonly backingRetentionMs: number;

  /** Which sources own the summing bus, and how the mix moves between them. */
  private readonly bus: MixBus;
  private readonly retentionSamples: number;
  private readonly backingRetentionSamples: number;

  /** Current canonical MicTrack — N=1's existing runtime now uses this state. */
  private readonly micTrack: MicTrack;
  /**
   * A second singer (Choir B), mixed into this same room output so Listen,
   * Take and timing need no separate path. Null whenever no B is attached;
   * every B line in `mixFrame` is then skipped and the N=1 mix is unchanged.
   */
  private secondary: SecondaryVoice | null = null;
  private readonly micTrackOptions: ConstructorParameters<typeof MicTrack>[0];
  private readonly mic: PcmTimeline;
  private readonly backing = emptyPcmTimeline();

  private running = false;
  private startedAt = 0;
  private frameIndex = 0;
  private sessionGeneration = 0;

  private readonly micGain: MicGainRamp;
  private roomMicGainDb: number;
  private micPremixedValue = false;

  /**
   * In-band capture-clock restarts cannot retire queued old PCM at ingest time.
   * Keep every unread old-capture frontier in order: more than one restart can
   * arrive before the mix read head reaches the first boundary.
   */
  private readonly micCaptureRestartBoundaries: CaptureRestartBoundaries;
  private readonly backingCaptureRestartBoundaries = new CaptureRestartBoundaries();
  /** Proven raw-input flat tops of the Mic, on its retained session timeline. */
  private readonly micInputClipping: MicInputClipping;
  /**
   * Audible edges of each source at the mix output: replacement transitions,
   * and missing-source fades that a timeline which is contiguous again (late
   * PCM filled what an earlier frame emitted as silence) cannot rewrite.
   */
  private readonly micEdge: SourceOutputEdge;
  private readonly backingEdge: SourceOutputEdge;
  private readonly sourceEdgeFadeSamples: number;

  private backingStarvedFrames = 0;

  private backingUnplayableRunFrames = 0;
  private clippedSamples = 0;
  private limitedSamples = 0;
  private heavyLimitedSamples = 0;

  private readonly micLimiter: MicLimiter;

  private readonly micRawMeter: MicRawMeter;

  /** Holds the Mic read head inside audio that has arrived. */
  private readonly micFrontier: MicFrontierCorrection;
  private readonly micClockTrim: MicClockTrim;
  private backingHeadroomMs = 0;

  constructor(options: AudioSessionOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs;
    this.frameSamples = Math.round((options.sampleRate * options.frameMs) / 1000);
    this.prebufferMs = options.prebufferMs;
    this.sourceEdgeFadeSamples = Math.max(
      1,
      Math.round((SOURCE_GAP_DECLICK_MS * options.sampleRate) / 1000),
    );
    this.micTrackOptions = {
      sampleRate: options.sampleRate,
      prebufferMs: options.prebufferMs,
      retentionMs: options.retentionMs,
      frameMs: options.frameMs,
      frameSamples: this.frameSamples,
      sourceEdgeFadeSamples: this.sourceEdgeFadeSamples,
      safetyMs: ADVANCE_SAFETY_MS,
      slewFraction: RUNTIME_CALIBRATION_SLEW_FRACTION,
      readHeadCrossfadeMs: MIC_READ_HEAD_CROSSFADE_MS,
    };
    this.micTrack = new MicTrack(this.micTrackOptions);
    // Keep the existing single-Mic methods literally unchanged: their fields
    // point to exactly the same component instances owned by micTrack.
    this.mic = this.micTrack.timeline;
    this.micGain = this.micTrack.gain;
    this.roomMicGainDb = this.micGain.targetDb;
    this.micLimiter = this.micTrack.limiter;
    this.micRawMeter = this.micTrack.meter;
    this.micCaptureRestartBoundaries = this.micTrack.captureRestarts;
    this.micInputClipping = this.micTrack.clipping;
    this.micEdge = this.micTrack.edge;
    this.micFrontier = this.micTrack.frontier;
    this.micClockTrim = this.micTrack.clockTrim;

    this.bus = new MixBus({
      sampleRate: options.sampleRate,
      backingGain: options.backingGain,
      voiceCeiling: this.micLimiter.ceiling,
    });
    this.backingEdge = new SourceOutputEdge(this.sourceEdgeFadeSamples);
    this.retentionMs = options.retentionMs;
    this.retentionSamples = Math.round((options.retentionMs * options.sampleRate) / 1000);
    this.backingRetentionMs = options.backingRetentionMs ?? 1_000;
    this.backingRetentionSamples = Math.round((this.backingRetentionMs * options.sampleRate) / 1000);
  }

  get active() {
    return this.running;
  }

  /** Increments whenever the mix clock restarts; alignment is scoped to it. */
  get generation() {
    return this.sessionGeneration;
  }

  /** Capture session of the microphone stream currently on the timeline. */
  get micGeneration() {
    return this.mic.generation;
  }

  /** Capture session of the captured-song stream currently on the timeline. */
  get backingGeneration() {
    return this.backing.generation;
  }

  /**
   * How far the microphone timeline actually reaches. `readMic` pads anything
   * past this with zeros, so a reader that needs real audio - rather than a
   * best effort - has to wait for this to pass the end of its range.
   */
  get micTotalSamples() {
    return this.mic.totalSamples;
  }

  /**
   * Mic audio buffered beyond what the last mixed frame read, or null before
   * the mix is running. Unrounded, unlike health(): callers use it as a live
   * budget for how long a transport may wait before the read head needs PCM.
   */
  get liveMicHeadroomMs(): number | null {
    return this.running ? this.micTrack.micHeadroomMs : null;
  }

  /** Samples of real Mic holes filled by concealment since the session began. */
  get micConcealedSampleCount() {
    return this.micTrack.micConcealedSamples;
  }

  /** Capture clock error the Mic timeline is currently trimmed for, in ppm. */
  get micClockTrimPpm() {
    return this.micClockTrim.ppm;
  }

  /** Net samples inserted (positive) or removed by the trim for this capture. */
  get micClockTrimSamples() {
    return this.micClockTrim.samples;
  }

  /**
   * Trims the Mic timeline for a capture clock running `ppm` slow (positive)
   * or fast (negative) against the mix clock. Null, or an estimate inside the
   * estimator's own error, stops trimming. A capture restart clears it: the
   * next capture has its own clock and must be measured again.
   */
  setMicClockTrimPpm(ppm: number | null) {
    this.micClockTrim.setPpm(ppm);
  }

  /** The same frontier for the captured song. See `micTotalSamples`. */
  get backingTotalSamples() {
    return this.backing.totalSamples;
  }

  /**
   * Whether the mixer has emitted complete real source frames within the same
   * safety window used for Mic frontier recovery.
   *
   * Transport freshness is deliberately separate: a socket can be receiving a
   * burst of stale backlog while the current mix frame is still silence.
   */
  get micPlayable() {
    return this.micTrack.micUnplayableRunFrames <= Math.ceil(ADVANCE_SAFETY_MS / this.frameMs);
  }

  get backingPlayable() {
    return this.backingUnplayableRunFrames <= Math.ceil(ADVANCE_SAFETY_MS / this.frameMs);
  }

  /**
   * Classifies a metadata-capable Backing registration against the capture
   * clock already retained by this mix. A reconnect may be ahead because the
   * sender keeps its source clock running while transport is down; only a
   * rewind, generation change or source-rate change proves replacement.
   */
  backingCaptureReplacedBy(input: {
    generation: number;
    sourceRate: number;
    sampleCursor: number;
  }) {
    const established = this.backing.totalSamples > 0
      || this.backing.generation !== null
      || this.backing.sourceRate !== null
      || this.backing.sourceFrontier !== null;
    if (!established) return false;

    return this.backing.generation !== input.generation
      || this.backing.sourceRate !== input.sourceRate
      || this.backing.sourceFrontier === null
      || input.sampleCursor < this.backing.sourceFrontier;
  }

  start(nowMs = performance.now()) {
    this.running = true;
    this.resetEpoch(nowMs);
  }

  stop() {
    this.running = false;
    this.micTrack.alignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
    this.micTrack.calibratedMicLagTargetMs = null;
    this.micTrack.calibrationUnfoldedSamples = 0;
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
    if (this.secondary) this.resetSecondary(this.secondary, true);
    this.resetHealth();
  }

  /**
   * Restarts the mix clock. Both timelines must be cleared together or their
   * indices stop describing the same moment.
   */
  resetEpoch(nowMs = performance.now()) {
    this.startedAt = nowMs;
    this.frameIndex = 0;
    this.sessionGeneration += 1;
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
    // The frontier correction described the old timelines' positions.
    this.micFrontier.reset(this.mic.generation);
    // A pending correction belongs to the old mix epoch. Preserve the value
    // already being applied but do not continue walking an old target forward.
    this.micTrack.calibratedMicLagTargetMs = this.micTrack.alignmentState.calibratedMicLagMs;
    this.bus.reset();
    this.micGain.reset();
    if (this.secondary) this.resetSecondary(this.secondary, false);
    this.resetHealth();
  }

  /**
   * Whether a source is meant to be streaming. Starvation is only meaningful
   * for a source that is supposed to be there; an absent phone is not a fault.
   */
  setMicExpected(expected: boolean) {
    this.bus.setMicExpected(expected, this.running);
  }

  setBackingExpected(expected: boolean) {
    this.bus.setBackingExpected(expected, this.running);
  }

  /** The room's Mic gain setting, kept while a premixed capture overrides it. */
  get micGainDb() {
    return this.roomMicGainDb;
  }

  /** The gain the Mic samples are actually mixed at. */
  get effectiveMicGainDb() {
    return this.micGain.targetDb;
  }

  get micPremixed() {
    return this.micPremixedValue;
  }

  setMicGainDb(value: number) {
    this.roomMicGainDb = value;
    this.applyMicGain();
  }

  /**
   * A premixed capture already carries the singer's gain and the song: the
   * phone mixed them before sending. Raising it by the room's voice gain would
   * clip it, so it is mixed at unity while the room setting is kept for the
   * next ordinary capture.
   */
  setMicPremixed(premixed: boolean) {
    this.micPremixedValue = premixed;
    this.applyMicGain();
  }

  private applyMicGain() {
    this.micGain.setTargetDb(this.micPremixedValue ? 0 : this.roomMicGainDb, this.running);
  }

  /**
   * Starts holding a second singer's PCM. Silent until it has a lag. A voice
   * still fading out is not revived: whoever comes next (the same B
   * reconnecting, or a C who took the seat) starts on a fresh track once the
   * fade is done, never on the last singer's lag, gain or limiter state.
   * Returns whether a fresh voice is attached.
   */
  attachSecondaryMic() {
    if (this.secondary) return !this.secondary.detaching;
    this.secondary = {
      track: new MicTrack(this.micTrackOptions),
      audible: false, blend: 0, detaching: false, sumGain: 1,
      gapSamples: 0, starvedSamples: 0, mixedFrames: 0, heardAtFrame: null, pendingLagMs: null,
    };
    return true;
  }

  /** Fades the second singer out, then drops it. */
  detachSecondaryMic() {
    if (!this.secondary) return;
    this.secondary.audible = false;
    this.secondary.detaching = true;
  }

  ingestSecondaryMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    const secondary = this.secondary;
    if (!secondary || secondary.detaching) return null;
    return secondary.track.ingestCapture({
      frame, sourceRate, running: this.running,
      roomSampleNow: () => this.currentSessionSample(nowMs),
    });
  }

  /**
   * The second singer's read-ahead, in the same coordinates as the main
   * Mic's. Null silences it (faded) without dropping its PCM. The first lag,
   * or one set while it is silent, applies at once; later changes ease in
   * exactly as the main Mic's runtime corrections do. A change too large to
   * ease (from no song to a song's measurement and back, often a second or
   * more, which the 1% slew would take minutes over) fades B out, jumps and
   * fades B back in.
   */
  setSecondaryMicLag(lagMs: number | null) {
    const secondary = this.secondary;
    if (!secondary) return;
    secondary.pendingLagMs = null;
    if (lagMs === null || !Number.isFinite(lagMs)) {
      secondary.audible = false;
      return;
    }
    const track = secondary.track;
    const current = track.alignmentState.calibratedMicLagMs;
    if (current === null || secondary.blend === 0 || !this.running) {
      track.alignmentState = { ...track.alignmentState, calibratedMicLagMs: lagMs };
    } else if (Math.abs(lagMs - current) > SECONDARY_JUMP_MS) {
      secondary.pendingLagMs = lagMs;
    }
    if (secondary.pendingLagMs === null) track.calibratedMicLagTargetMs = lagMs;
    if (!secondary.detaching) secondary.audible = true;
  }

  setSecondaryMicGainDb(value: number) {
    this.secondary?.track.gain.setTargetDb(value, this.running);
  }

  /** B's session position for one of its recent capture samples (sample/song anchors). */
  secondarySampleSongPosition(generation: number, index: number, rate: number) {
    const timeline = this.secondary?.track.timeline;
    if (!timeline || timeline.generation !== generation || timeline.sourceRate !== rate
        || timeline.sourceFrontier === null || !Number.isFinite(index)
        || index < 0 || index > timeline.sourceFrontier
        || timeline.sourceFrontier - index > rate) return null;
    return timeline.totalSamples - (timeline.sourceFrontier - index) * this.sampleRate / rate;
  }

  /** What the second singer is doing in the mix; null with no B attached. */
  get secondaryMic() {
    const secondary = this.secondary;
    if (!secondary) return null;
    return {
      audible: secondary.audible,
      blend: secondary.blend,
      lagMs: secondary.track.alignmentState.calibratedMicLagMs,
      targetLagMs: secondary.pendingLagMs ?? secondary.track.calibratedMicLagTargetMs,
      gainDb: secondary.track.gain.targetDb,
      gapSamples: secondary.gapSamples,
      starvedSamples: secondary.starvedSamples,
      mixedFrames: secondary.mixedFrames,
      /** B's PCM reached the mix within the last SECONDARY_HEARD_WINDOW_MS. */
      recentlyHeard: secondary.heardAtFrame !== null
        && (this.frameIndex - secondary.heardAtFrame) * this.frameSamples * 1000
          <= SECONDARY_HEARD_WINDOW_MS * this.sampleRate,
      /** Everything B has sent since this track began (not a backlog). */
      bufferedSamples: secondary.track.timeline.totalSamples,
      /** B's audio that has arrived past this frame's read: its real buffer. */
      headroomMs: Math.round(secondary.track.micHeadroomMs),
      /** The rate every *Samples field above counts in. */
      sampleRate: this.sampleRate,
    };
  }

  /** B's timeline and read trajectory, as clearTimeline/resetEpoch do for A. */
  private resetSecondary(secondary: SecondaryVoice, stopping: boolean) {
    const track = secondary.track;
    track.clockTrim.reset();
    track.lastEmittedMicAdvanceSamples = null;
    track.lastEmittedMicFrameComplete = false;
    track.lastEmittedMicSourceSample = null;
    track.captureRestarts.clear();
    track.clipping.clear();
    resetPcmTimeline(track.timeline);
    track.frontier.reset(track.timeline.generation);
    track.gain.reset();
    track.calibratedMicLagTargetMs = track.alignmentState.calibratedMicLagMs;
    secondary.pendingLagMs = null;
    // Its PCM is gone, and the frame count may restart.
    secondary.heardAtFrame = null;
    if (stopping) {
      track.alignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
      track.calibratedMicLagTargetMs = null;
      secondary.audible = false;
      secondary.blend = 0;
    }
  }

  /** Recent capture coordinate mapped through the current ingest transform.
   * Only a short neighborhood is valid: historical trim/fold transforms differ. */
  sampleSongPosition(source: 'mic' | 'backing', generation: number, index: number, rate: number) {
    const timeline = source === 'mic' ? this.mic : this.backing;
    if (timeline.generation !== generation || timeline.sourceRate !== rate
        || timeline.sourceFrontier === null || !Number.isFinite(index)
        || index < 0 || index > timeline.sourceFrontier
        || timeline.sourceFrontier - index > rate) return null;
    return timeline.totalSamples - (timeline.sourceFrontier - index) * this.sampleRate / rate;
  }

  get alignment(): AlignmentState {
    return { ...this.micTrack.alignmentState };
  }

  /** Current target, equal to the applied lag when no runtime slew is pending. */
  get calibratedMicLagTarget() {
    return this.micTrack.calibratedMicLagTargetMs;
  }

  /** Immediate authority change used by existing initial/manual/robot semantics. */
  setAlignment(patch: Partial<AlignmentState>) {
    this.micTrack.alignmentState = { ...this.micTrack.alignmentState, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'calibratedMicLagMs')) {
      this.micTrack.calibratedMicLagTargetMs = patch.calibratedMicLagMs ?? null;
    }
  }

  /**
   * Changes only the target. `mixFrame` advances the applied read head gradually
   * so live validation cannot skip/repeat the full correction in one frame.
   */
  slewCalibratedMicLagTo(targetMs: number) {
    if (!Number.isFinite(targetMs)) return false;
    const current = this.micTrack.alignmentState.calibratedMicLagMs;
    if (current === null || !this.running) {
      const changed = current !== targetMs || this.micTrack.calibratedMicLagTargetMs !== targetMs;
      this.setAlignment({ calibratedMicLagMs: targetMs });
      return changed;
    }
    if (this.micTrack.calibratedMicLagTargetMs === targetMs) return false;
    this.micTrack.calibratedMicLagTargetMs = targetMs;
    return true;
  }

  /** Every advance budget delegates to the canonical singer-owned MicTrack. */
  get requestedMicAdvanceMs() {
    return this.micTrack.requestedMicAdvanceMs;
  }

  private budgetedMicAdvanceMs(requestedMicAdvanceMs = this.requestedMicAdvanceMs) {
    return this.micTrack.budgetedMicAdvanceMs(requestedMicAdvanceMs);
  }

  get appliedMicAdvanceMs() {
    return this.micTrack.appliedMicAdvanceMs;
  }

  /**
   * Runtime hold-back needed only because the live Mic frontier is behind the
   * mix clock. This is separate from a requested alignment exceeding the
   * configured prebuffer/retention budget.
   */
  get micFrontierCorrectionMs() {
    return (this.micFrontier.correctionSamples / this.sampleRate) * 1000;
  }

  /**
   * Real time Mic capture `generation` is known to have lost, measured outside
   * the mixer (MicCaptureDeliveryMonitor). Only a matching capture uses it.
   */
  noteMicCaptureLoss(generation: number, lossMs: number) {
    this.micFrontier.noteCaptureLoss(generation, lossMs);
  }

  /**
   * Captured Mic audio of capture `generation` that had not reached Relay at
   * its latest uplink report (MicUplinkBacklog). Only the current capture uses it.
   */
  /** Whether the current capture's audio is in transit beyond ordinary delay. */
  get micAudioInTransit() {
    return this.micFrontier.transitActive;
  }

  noteMicTransitBacklog(generation: number, backlogMs: number) {
    if (generation !== this.mic.generation) return;
    this.micFrontier.noteTransit(backlogMs);
  }

  /** Folds of confirmed capture loss into the Mic timeline since this mixer was created. */
  get micTimelineFoldCount() {
    return this.micFrontier.foldCount;
  }

  get lastMicTimelineFold() {
    return this.micFrontier.lastFold;
  }

  /** Folds undone since this mixer was created (see MicFrontierCorrection.unfoldDue). */
  get micTimelineUnfoldCount() {
    return this.micFrontier.unfoldCount;
  }

  get lastMicTimelineUnfold() {
    return this.micFrontier.lastUnfold;
  }

  /** How far folds have moved the current capture's timeline, net of unfolds, in ms. */
  get micTimelineFoldedMs() {
    return (this.micFrontier.timelineFoldedSamplesNow / this.sampleRate) * 1000;
  }

  /**
   * A calibration measured from the Mic timeline as it stands now is in force.
   * The server calls this for each new measurement, not when it reapplies an
   * old one.
   */
  noteMicCalibrationMeasured() {
    this.micTrack.calibrationUnfoldedSamples = 0;
    this.micFrontier.noteCalibrationMeasured();
  }

  /** The track's retained history bounds its own frontier correction. */
  private micFrontierCorrectionCapSamples() {
    return this.micTrack.frontierCorrectionCapSamples();
  }

  /**
   * Folds Mic capture loss the phone has confirmed into the timeline before the
   * frontier correction covering it runs out of room (see
   * MicFrontierCorrection.foldDue for why), and takes a fold back out when the
   * loss it folded falls again (MicFrontierCorrection.unfoldDue). A calibration
   * measured across that fold gives it up too (unfoldMeasuredAcross), and the
   * correction keeps the read head on the audio it was reading.
   *
   * Runs before a frame reads any of the previous frame's read state, so that
   * state moves with the timeline.
   */
  private foldConfirmedMicCaptureLoss() {
    const correctionBefore = this.micFrontier.correctionSamples;
    const shift = this.micFrontier.foldDue(
      this.bus.micExpected,
      this.mic.generation,
      this.micFrontierCorrectionCapSamples(),
    );
    if (shift > 0) {
      this.micTrack.rebaseCaptureTimeline(shift);
      this.micFrontier.folded(shift, correctionBefore);
      return;
    }
    const unfold = this.micFrontier.unfoldDue(
      this.bus.micExpected,
      this.mic.generation,
      this.micFrontierCorrectionCapSamples(),
    );
    if (unfold === 0) return;
    const measuredAcross = this.micFrontier.unfoldMeasuredAcross(unfold);
    const advanceBefore = this.budgetedMicAdvanceMs();
    this.micTrack.calibrationUnfoldedSamples += measuredAcross;
    const advanceAfter = this.budgetedMicAdvanceMs();
    this.micTrack.rebaseCaptureTimeline(-unfold);
    // The advance itself moved back by up to the part measured across, so the
    // correction holds only what the advance did not.
    this.micFrontier.release(Math.round(((advanceBefore - advanceAfter) * this.sampleRate) / 1000));
    this.micFrontier.unfolded(unfold, correctionBefore, measuredAcross);
  }

  ingestMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    return this.micTrack.ingestCapture({
      frame, sourceRate, running: this.running,
      roomSampleNow: () => this.currentSessionSample(nowMs),
    });
  }

  ingestBacking(
    frame: PcmFrame,
    sourceRate: number | null,
    nowMs = performance.now(),
    trackSourceClock = false,
  ) {
    const previousTotalSamples = this.backing.totalSamples;
    const previousChunk = this.backing.chunks.at(-1) ?? null;
    const result = this.ingest(
      this.backing,
      frame,
      sourceRate,
      nowMs,
      trackSourceClock,
      true,
    );
    const currentChunk = this.backing.chunks.at(-1) ?? null;
    if (result.captureRestarted && this.running) {
      this.backingCaptureRestartBoundaries.queue(previousTotalSamples);
    }

    // A positioned transport/backlog hole is truthful silence, but the abrupt
    // song -> zero -> song waveform splice is not. Taper only the real PCM
    // adjacent to the proven hole; keep its position and evidence unchanged.
    // Keep capture-clock restarts byte-exact in retained source history.
    // Same-capture transport holes use the in-timeline taper; bind-time
    // replacement edges are handled separately at the mix output boundary.
    const startsAfterGap = Boolean(
      !result.captureRestarted
      && previousChunk
      && currentChunk
      && currentChunk !== previousChunk
      && currentChunk.samples.length > 0
      && currentChunk.start > previousTotalSamples
    );
    if (startsAfterGap && previousChunk && currentChunk) {
      // The Backing is read at the mix position itself.
      declickSourceGap(
        previousChunk, currentChunk.samples,
        this.frameIndex * this.frameSamples, this.sourceEdgeFadeSamples,
      );
    }
    return result;
  }

  /** Exposed for the click diagnostic, which mixes against the microphone. */
  readMic(startSample: number, count: number) {
    return readPcmRange(this.mic, startSample, count);
  }

  /** Missing-source evidence for exactly the same microphone range `readMic` reads. */
  readMicEvidence(startSample: number, count: number) {
    return readPcmEvidence(this.mic, startSample, count);
  }

  /** The second singer's timeline, as `readMic` reads the main Mic's; silence with no B. */
  readSecondaryMic(startSample: number, count: number) {
    const timeline = this.secondary?.track.timeline;
    return timeline ? readPcmRange(timeline, startSample, count) : new Int16Array(Math.max(0, count));
  }

  /** Missing-source evidence for the range `readSecondaryMic` reads; null with no B. */
  readSecondaryMicEvidence(startSample: number, count: number) {
    const timeline = this.secondary?.track.timeline;
    return timeline ? readPcmEvidence(timeline, startSample, count) : null;
  }

  get secondaryMicTotalSamples() {
    return this.secondary?.track.timeline.totalSamples ?? 0;
  }

  /** The capture generation of B's PCM on the timeline; null with no B. */
  get secondaryMicGeneration() {
    return this.secondary?.track.timeline.generation ?? null;
  }

  /** The same window into the captured song, for locating a probe in it. */
  readBacking(startSample: number, count: number) {
    return readPcmRange(this.backing, startSample, count);
  }

  /** Missing-source evidence for exactly the same backing range `readBacking` reads. */
  readBackingEvidence(startSample: number, count: number) {
    return readPcmEvidence(this.backing, startSample, count);
  }

  /**
   * Session-sample coordinate for a real-world instant, independent of
   * either timeline's own anchor. This intentionally preserves fractional
   * sample position: command boundaries must quantize forward only after the
   * real instant is known. Callers that need an integer sample (such as probe
   * correlation) round explicitly at that boundary.
   */
  sessionSampleAt(nowMs: number) {
    return ((nowMs - this.startedAt) * this.sampleRate) / 1000;
  }

  trimMic(beforeSample: number) {
    this.trim(this.mic, beforeSample);
  }

  /**
   * Retires the capture that publisher activation has already replaced.
   *
   * This is intentionally source-local: an active Take keeps its mix generation
   * and Backing timeline. Clearing immediately prevents buffered PCM from the
   * retired singer/capture leaking into the bind-to-first-frame gap. Publisher
   * activation owns the bind-proven restart event; PCM reports only a later
   * capture-clock change that was not already known at bind.
   */
  retireMicCapture() {
    // Bind-time retirement has no old chunk left for declickSourceGap() to edit.
    // Preserve only the last contribution that was already audible, then taper
    // that value to whatever the next frame contains. No retired PCM survives.
    if (this.running) this.micEdge.beginReplacement();
    // Limiter and raw-level history describe the retired acoustic capture.
    // Keep cumulative Take evidence. Raw level can reset immediately; limiter
    // reset is deferred until replacement PCM is actually audible so a hot new
    // capture can seed a safe gain from its own look-ahead rather than jumping
    // blindly to unity.
    this.micTrack.micLimiterResetPending = true;
    this.micRawMeter.reset();
    this.clearTimeline(this.mic);
    this.micFrontier.reset(this.mic.generation);
  }

  /**
   * Retires only the captured-song clock once registration metadata has proven
   * that the new Backing transport cannot be a continuation of the old capture.
   * The shared mix epoch and Mic history remain intact.
   */
  retireBackingCapture() {
    if (this.running) this.backingEdge.beginReplacement();
    this.clearTimeline(this.backing);
  }

  clearMic() {
    this.clearTimeline(this.mic);
    this.micFrontier.reset(this.mic.generation);
  }

  /** Emits every frame whose time has come. Returns how many were produced. */
  drain(
    emit: (frame: Buffer, evidence: MixFrameEvidence, position: MixFramePosition) => void,
    nowMs = performance.now(),
    maxFrames = 5,
  ) {
    if (!this.running) return 0;

    const elapsed = nowMs - this.startedAt - this.prebufferMs;
    if (elapsed < 0) return 0;

    const expected = Math.floor(elapsed / this.frameMs) + 1;
    let remaining = Math.min(maxFrames, expected - this.frameIndex);
    let sent = 0;

    while (remaining > 0) {
      const mixed = this.mixFrame(this.frameIndex);
      emit(mixed.frame, mixed.evidence, {
        generation: this.sessionGeneration,
        firstSampleIndex: this.frameIndex * this.frameSamples,
      });
      this.frameIndex += 1;
      remaining -= 1;
      sent += 1;
    }

    return sent;
  }

  health(): MixHealth {
    return {
      micStarvedFrames: this.micTrack.micStarvedFrames,
      backingStarvedFrames: this.backingStarvedFrames,
      micHeadroomMs: Math.round(this.micTrack.micHeadroomMs),
      backingHeadroomMs: Math.round(this.backingHeadroomMs),
      micGapMs: Math.round((this.mic.gapSamples / this.sampleRate) * 1000),
      backingGapMs: Math.round((this.backing.gapSamples / this.sampleRate) * 1000),
      backingClockCorrectionSamples: this.backing.clockCorrectionSamples,
      clippedSamples: this.clippedSamples,
      limitedSamples: this.limitedSamples,
      micPeakDbfs: this.micRawMeter.peakDbfs,
      micRmsDbfs: this.micRawMeter.rmsDbfs,
      unheadered: this.mic.unheadered || this.backing.unheadered,
    };
  }

  resetHealth() {
    this.micTrack.micStarvedFrames = 0;
    this.backingStarvedFrames = 0;
    this.micTrack.micUnplayableRunFrames = 0;
    this.backingUnplayableRunFrames = 0;
    this.clippedSamples = 0;
    this.limitedSamples = 0;
    this.micRawMeter.reset();
    this.micTrack.micHeadroomMs = 0;
    this.backingHeadroomMs = 0;
    // These are audio state, not just diagnostics. Carrying gain reduction into
    // a new epoch makes the beginning of the next take inherit the previous
    // singer's last transient and can attenuate it for hundreds of milliseconds.
    this.micTrack.resetLimiterState();
    this.micEdge.reset();
    this.backingEdge.reset();
    this.micTrack.lastEmittedMicSourceSample = null;
    this.micCaptureRestartBoundaries.clear();
    this.backingCaptureRestartBoundaries.clear();
    this.mic.gapSamples = 0;
    this.backing.gapSamples = 0;
  }

  // ---------------------------------------------------------------- internals

  private clearTimeline(timeline: PcmTimeline) {
    if (timeline === this.mic) {
      this.micClockTrim.reset();
      this.resetMicReadContinuity();
      this.micTrack.lastEmittedMicSourceSample = null;
      this.micCaptureRestartBoundaries.clear();
      this.micInputClipping.clear();
    } else if (timeline === this.backing) {
      this.backingCaptureRestartBoundaries.clear();
    }
    resetPcmTimeline(timeline);
  }

  /** Forgets the trajectory the last emitted Mic frame was read along. */
  private resetMicReadContinuity() {
    this.micTrack.lastEmittedMicAdvanceSamples = null;
    this.micTrack.lastEmittedMicFrameComplete = false;
  }

  /** Where the session clock is now, in session samples since the epoch. */
  private currentSessionSample(nowMs = performance.now()) {
    return Math.round(((nowMs - this.startedAt) * this.sampleRate) / 1000);
  }

  private ingest(
    timeline: PcmTimeline,
    frame: PcmFrame,
    sourceRate: number | null,
    nowMs: number,
    trackSourceClock = false,
    sourceRateDefinesCapture = false,
  ): IngestResult {
    return ingestPcmTimeline({
      timeline, frame, sourceRate,
      mixRate: this.sampleRate,
      roomSampleNow: () => this.currentSessionSample(nowMs),
      trackSourceClock,
      sourceRateDefinesCapture,
      onCaptureClockChanged: timeline === this.mic
        ? () => this.micTrack.onCaptureClockReplaced()
        : undefined,
      trimSourcePacket: timeline === this.mic
        ? (input) => this.micTrack.trimSourcePacket(input)
        : undefined,
    });
  }

  private trim(timeline: PcmTimeline, beforeSample: number) {
    trimPcmTimeline(timeline, beforeSample);

    if (timeline === this.mic) {
      // Restart seams are output state only while either side can still be
      // revisited by the retained Mic read head.
      this.micCaptureRestartBoundaries.trimBefore(beforeSample);
      this.micInputClipping.trimBefore(beforeSample);
    }
  }

  /**
   * Removes only the artificial edge click around a proven positioned hole.
   *
   * The missing interval stays untouched silence on the timeline, and
   * `gapSamples` / per-frame evidence still report its full duration. This is
   * deliberately not packet-loss concealment: no old sample is stretched or
   * copied across the missing capture.
   */
  /**
   * The first Mic timeline sample the mix has not read. A slewed read
   * interpolates, so the sample after a fractional position was read too.
   */
  private beginBackingCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.backingCaptureRestartBoundaries.consumeThrough(sourceSample)) return;
    this.backingEdge.beginReplacement();
  }

  /** One room-owned clock tick; all source-specific planning runs on the track. */
  private planMicRead(frameIndex: number): MicReadPlan {
    // Timeline fold/rebase remains part of the canonical room ingest/clock
    // mapping. It MUST occur before reading any prior emitted Mic trajectory.
    this.foldConfirmedMicCaptureLoss();
    return this.micTrack.planMicRead(frameIndex * this.frameSamples, this.bus.micExpected);
  }

  /** Every Mic measures its own arrived source; backing stays room-owned. */
  private measureHeadroom(plan: MicReadPlan) {
    this.micTrack.measureReadHeadroom(plan, this.bus.micExpected);
    const startSample = plan.startSample;
    this.backingHeadroomMs =
      ((this.backing.totalSamples - (startSample + this.frameSamples)) / this.sampleRate) * 1000;
    if (this.backingHeadroomMs < 0 && this.bus.backingExpected) this.backingStarvedFrames += 1;
  }

  /** The song samples this frame mixes, read at the mix position itself, and their evidence. */
  private readBackingFrame(startSample: number) {
    const evidence = readPcmEvidence(this.backing, startSample, this.frameSamples);
    return {
      samples: readPcmRange(this.backing, startSample, this.frameSamples),
      evidence,
      gapMask: evidence.gapSamples > 0
        ? readPcmGapMask(this.backing, startSample, this.frameSamples)
        : null,
      frontierMissingStart: this.frameSamples - evidence.frontierMissingSamples,
    };
  }

  private mixFrame(frameIndex: number): { frame: Buffer; evidence: MixFrameEvidence } {
    const plan = this.planMicRead(frameIndex);
    const {
      startSample,
      micReadStart,
      advanceSamplesExact,
      advanceSamples,
      boundedRuntimeAdvanceMoved,
    } = plan;
    this.measureHeadroom(plan);
    const {
      samples: mic,
      slew: micSlew,
      evidence: micReadEvidence,
      gapMask: micGapMask,
      frontierMissingStart: micFrontierMissingStart,
      inputClippingMask: micInputClippingMask,
      crossfadeUnheaderedSamplesDelta,
      crossfadeInputClippedSamplesDelta: crossfadeMicInputClippedSamplesDelta,
    } = this.micTrack.readMicFrame(plan);
    const {
      samples: song,
      evidence: backingReadEvidence,
      gapMask: backingGapMask,
      frontierMissingStart: backingFrontierMissingStart,
    } = this.readBackingFrame(startSample);
    const duet = this.secondary ? this.readSecondaryFrame(this.secondary, startSample) : null;
    this.micTrack.micUnplayableRunFrames = this.bus.micExpected
      && micReadEvidence.gapSamples + micReadEvidence.frontierMissingSamples > 0
      ? this.micTrack.micUnplayableRunFrames + 1
      : 0;
    this.backingUnplayableRunFrames = this.bus.backingExpected
      && backingReadEvidence.gapSamples + backingReadEvidence.frontierMissingSamples > 0
      ? this.backingUnplayableRunFrames + 1
      : 0;

    const clippedBefore = this.clippedSamples;
    const limitedBefore = this.limitedSamples;
    const heavyLimitedBefore = this.heavyLimitedSamples;

    // Keep the musical ramp target fixed for this frame, even if a source's
    // retained tail finishes and releases its bus ownership within the frame.
    const duckTarget = this.bus.duckTarget();
    const output = Buffer.allocUnsafe(this.frameSamples * 2);
    const micSlewFrameEndPosition = micSlew
      ? micSlew.firstPosition + this.frameSamples * micSlew.rate
      : 0;

    for (let i = 0; i < this.frameSamples; i += 1) {
      // Ramped per sample: the room can gain or lose a microphone mid-song, and
      // several dB arriving in one sample is a click.
      this.bus.advanceDuck(duckTarget);
      const songGain = this.bus.songGain;

      const micSourceSample = micSlew
        ? micSlew.firstPosition + i * micSlew.rate
        : micReadStart + i;
      // A retained restart can be ingested well before the read head reaches
      // it. Keep old-capture limiting until the audible trajectory actually
      // crosses the semantic boundary. The first real replacement sample then
      // seeds fresh dynamics from replacement PCM itself.
      const micEvidenceMissing = micSlew
        ? micSlew.missingMask[i] === 1
        : micGapMask?.[i] === 1 || i >= micFrontierMissingStart;
      // Negative session positions are structural pre-roll, not source failure,
      // so they stay out of MixFrameEvidence. They are still literal silence at
      // the output, though, and crossing from that silence back into real PCM
      // must own the same bounded de-click edge as any other audible absence.
      const micAudibleMissing = micSourceSample < 0 || micEvidenceMissing;
      const backingSourceSample = startSample + i;
      const backingSourceMissing =
        backingGapMask?.[i] === 1 || i >= backingFrontierMissingStart;
      const effectiveTwoSourceOwnership = this.bus.twoSourceOwnership;

      const processedVoice = this.micTrack.processVoiceSample({
        samples: mic,
        i,
        sourceSample: micSourceSample,
        micReadStart,
        slew: micSlew,
        slewFrameEndPosition: micSlewFrameEndPosition,
        evidenceMissing: micEvidenceMissing,
        audibleMissing: micAudibleMissing,
      });
      const voice = duet ? this.withSecondaryVoice(duet, i, processedVoice.voice) : processedVoice.voice;
      if (processedVoice.limited) this.limitedSamples += 1;
      if (processedVoice.heavilyLimited) this.heavyLimitedSamples += 1;
      // Release only once the departing source has run out: silent at the
      // output *and* read past everything it retained. A hole inside the tail
      // also silences it, and releasing there un-ducked the song and dropped
      // the summing headroom under the retained PCM after the hole.
      if (
        this.bus.micReleaseHeld
        && !this.bus.micExpected
        && this.micEdge.silenced
        && !this.micEdge.replacementActive
        && !retainsPcmAfter(this.mic, micSourceSample)
      ) {
        this.bus.releaseMicHold();
      }

      let songContribution = (song[i] / 32768) * songGain;
      this.beginBackingCaptureRestartEdgeIfDue(backingSourceSample);
      songContribution = this.backingEdge.apply(
        songContribution,
        backingSourceMissing,
        backingSourceMissing,
      );
      if (
        this.bus.backingReleaseHeld
        && !this.bus.backingExpected
        && this.backingEdge.silenced
        && !this.backingEdge.replacementActive
        && !retainsPcmAfter(this.backing, backingSourceSample)
      ) {
        this.bus.releaseBackingHold();
      }
      const value = this.bus.mixSample(
        voice,
        songContribution,
        effectiveTwoSourceOwnership,
        micAudibleMissing,
        backingSourceMissing,
      );

      // Normal two-source peaks have already had deterministic summing headroom
      // reserved. Keep this clamp as an invariant/backstop for unexpected future
      // inputs or limiter overshoot, and keep counting it as audible distortion.
      if (value > 1 || value < -1) this.clippedSamples += 1;
      const clamped = Math.max(-1, Math.min(1, value));
      output.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
    }

    let micInputClippedSamples = 0;
    if (micInputClippingMask) {
      for (let i = 0; i < micInputClippingMask.length; i += 1) {
        if (micInputClippingMask[i] !== 1) continue;
        const missing = micSlew
          ? micSlew.missingMask[i] === 1
          : micGapMask?.[i] === 1 || i >= micFrontierMissingStart;
        if (!missing) micInputClippedSamples += 1;
      }
    }
    micInputClippedSamples += crossfadeMicInputClippedSamplesDelta;

    const evidence: MixFrameEvidence = {
      micGapSamples: micReadEvidence.gapSamples,
      backingGapSamples: backingReadEvidence.gapSamples,
      micStarvedSamples: this.bus.micExpected ? micReadEvidence.frontierMissingSamples : 0,
      backingStarvedSamples: this.bus.backingExpected ? backingReadEvidence.frontierMissingSamples : 0,
      micUnavailableSamples: this.bus.micExpected ? 0 : micReadEvidence.frontierMissingSamples,
      backingUnavailableSamples: this.bus.backingExpected ? 0 : backingReadEvidence.frontierMissingSamples,
      clippedSamples: this.clippedSamples - clippedBefore,
      micInputClippedSamples: Math.max(0, micInputClippedSamples),
      limitedSamples: this.limitedSamples - limitedBefore,
      heavyLimitedSamples: this.heavyLimitedSamples - heavyLimitedBefore,
      unheaderedSamples:
        micReadEvidence.unheaderedSamples
        + backingReadEvidence.unheaderedSamples
        + crossfadeUnheaderedSamplesDelta,
      ...(duet ? this.secondaryFrameEvidence(duet) : {}),
    };

    this.micTrack.lastEmittedMicAdvanceSamples = boundedRuntimeAdvanceMoved
      ? advanceSamplesExact
      : advanceSamples;
    this.micTrack.lastEmittedMicFrameComplete =
      micReadEvidence.gapSamples === 0
      && micReadEvidence.frontierMissingSamples === 0;

    this.trim(this.mic, startSample - this.retentionSamples);
    this.trim(this.backing, startSample - this.backingRetentionSamples);
    if (duet) this.finishSecondaryFrame(duet, startSample);
    return { frame: output, evidence };
  }

  /** What B contributed to this frame's evidence; zeros while B is silent. */
  private secondaryFrameEvidence(duet: SecondaryFrame) {
    const audible = duet.secondary.audible;
    return {
      secondaryAudibleSamples: audible ? this.frameSamples : 0,
      secondaryGapSamples: audible ? duet.read.evidence.gapSamples : 0,
      secondaryStarvedSamples: audible ? duet.read.evidence.frontierMissingSamples : 0,
    };
  }

  /** B's frame at the same room position, planned on B's own track. */
  private readSecondaryFrame(secondary: SecondaryVoice, startSample: number): SecondaryFrame {
    const track = secondary.track;
    const plan = track.planMicRead(startSample, secondary.audible);
    track.measureReadHeadroom(plan, secondary.audible);
    const read = track.readMicFrame(plan);
    return {
      secondary, plan, read,
      slewFrameEndPosition: read.slew ? read.slew.firstPosition + this.frameSamples * read.slew.rate : 0,
      blendStep: 1 / Math.max(1, Math.round((SECONDARY_BLEND_MS * this.sampleRate) / 1000)),
      sumReleaseStep: 1 - Math.exp(-1000 / (SECONDARY_SUM_RELEASE_MS * this.sampleRate)),
    };
  }

  /**
   * One sample of A and B together: their sum, as two singers in one room
   * would sound, so a harmony keeps the balance they sang it at. The bus
   * reserves summing headroom for one voice at the limiter ceiling, so a sum
   * that would pass the ceiling is turned down: at once when it does, and
   * back up over SECONDARY_SUM_RELEASE_MS. The output never exceeds the
   * ceiling, and a singer alone is untouched. B fades in and out over
   * SECONDARY_BLEND_MS, so joining is not a click.
   */
  private withSecondaryVoice(duet: SecondaryFrame, i: number, primaryVoice: number) {
    const { secondary, plan, read } = duet;
    const sourceSample = read.slew ? read.slew.firstPosition + i * read.slew.rate : plan.micReadStart + i;
    const evidenceMissing = read.slew
      ? read.slew.missingMask[i] === 1
      : read.gapMask?.[i] === 1 || i >= read.frontierMissingStart;
    const processed = secondary.track.processVoiceSample({
      samples: read.samples,
      i,
      sourceSample,
      micReadStart: plan.micReadStart,
      slew: read.slew,
      slewFrameEndPosition: duet.slewFrameEndPosition,
      evidenceMissing,
      audibleMissing: sourceSample < 0 || evidenceMissing,
    });
    const target = secondary.audible && secondary.pendingLagMs === null ? 1 : 0;
    secondary.blend = secondary.blend < target
      ? Math.min(target, secondary.blend + duet.blendStep)
      : Math.max(target, secondary.blend - duet.blendStep);
    if (secondary.blend === 0 && secondary.sumGain === 1) return primaryVoice;
    const ceiling = this.micLimiter.ceiling;
    const a = Math.max(-ceiling, Math.min(ceiling, primaryVoice));
    const b = Math.max(-ceiling, Math.min(ceiling, processed.voice));
    const sum = a + b * secondary.blend;
    const allowed = Math.abs(sum) > ceiling ? ceiling / Math.abs(sum) : 1;
    secondary.sumGain = allowed < secondary.sumGain
      ? allowed
      : Math.min(allowed, secondary.sumGain + duet.sumReleaseStep * (1 - secondary.sumGain));
    return sum * secondary.sumGain;
  }

  private finishSecondaryFrame(duet: SecondaryFrame, startSample: number) {
    const { secondary, plan, read } = duet;
    const track = secondary.track;
    track.lastEmittedMicAdvanceSamples = plan.boundedRuntimeAdvanceMoved
      ? plan.advanceSamplesExact
      : plan.advanceSamples;
    track.lastEmittedMicFrameComplete = read.evidence.gapSamples === 0
      && read.evidence.frontierMissingSamples === 0;
    if (secondary.audible) {
      secondary.gapSamples += read.evidence.gapSamples;
      secondary.starvedSamples += read.evidence.frontierMissingSamples;
      secondary.mixedFrames += 1;
    }
    if (read.evidence.gapSamples + read.evidence.frontierMissingSamples < this.frameSamples) {
      secondary.heardAtFrame = this.frameIndex;
    }
    // Faded out for a jump: B comes back in at the new lag from the next frame.
    if (secondary.pendingLagMs !== null && secondary.blend === 0) {
      track.alignmentState = { ...track.alignmentState, calibratedMicLagMs: secondary.pendingLagMs };
      track.calibratedMicLagTargetMs = secondary.pendingLagMs;
      secondary.pendingLagMs = null;
    }
    trimPcmTimeline(track.timeline, startSample - this.retentionSamples);
    track.captureRestarts.trimBefore(startSample - this.retentionSamples);
    track.clipping.trimBefore(startSample - this.retentionSamples);
    if (secondary.detaching && secondary.blend === 0) this.secondary = null;
  }
}

/** How long B takes to fade in or out of the room mix. */
const SECONDARY_BLEND_MS = 50;
/** A change in B's lag larger than this fades out and jumps instead of easing. */
const SECONDARY_JUMP_MS = 100;
/** How recent B's PCM must be for B to count as singing, not just allowed to. */
const SECONDARY_HEARD_WINDOW_MS = 500;
/** How fast the A+B sum comes back up after a peak turned it down. */
const SECONDARY_SUM_RELEASE_MS = 80;

type SecondaryVoice = {
  track: MicTrack;
  audible: boolean;
  /** 0 = A alone; 1 = B at full level. */
  blend: number;
  /** Gain on the A+B sum that keeps it under the ceiling; 1 = untouched. */
  sumGain: number;
  detaching: boolean;
  gapSamples: number;
  starvedSamples: number;
  mixedFrames: number;
  /** The last mix frame that held any of B's PCM; null before the first. */
  heardAtFrame: number | null;
  /** A lag too far to ease to, applied once B has faded out; null otherwise. */
  pendingLagMs: number | null;
};

type SecondaryFrame = {
  secondary: SecondaryVoice;
  plan: MicReadPlan;
  read: ReturnType<MicTrack['readMicFrame']>;
  slewFrameEndPosition: number;
  blendStep: number;
  sumReleaseStep: number;
};
