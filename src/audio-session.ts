import { performance } from 'node:perf_hooks';

import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import { concealGap } from './packet-loss-concealment.js';
import type { PcmFrame } from './pcm-frame.js';
import {
  compressPcmSpanByOne,
  emptyPcmTimeline,
  readPcmEvidence,
  readPcmGapMask,
  readPcmRange,
  resamplePcm,
  resetPcmTimeline,
  retainsPcmAfter,
  RESAMPLE_TAIL_SAMPLES,
  stretchPcmSpanByOne,
  trimPcmTimeline,
  type PcmChunk,
  type PcmTimeline,
} from './pcm-timeline.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { MicGainRamp } from './mic-gain-ramp.js';
import { MicLimiter } from './mic-limiter.js';
import { MicRawMeter } from './mic-raw-meter.js';
import { readMicSlewedRange, crossfadeMicReadHeadJump, type MicSlewRead } from './mic-frame-reader.js';
import { classifyMicReadMotion } from './mic-read-plan.js';
import { MixBus } from './mix-bus.js';
import { SourceOutputEdge } from './source-output-edge.js';

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

export type AlignmentState = {
  /** RTT/2 fallback used until an acoustic calibration succeeds. */
  networkCompensationMs: number;
  calibratedMicLagMs: number | null;
  fineTuneMs: number;
};

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
 * A sound device and `performance.now()` are independent clocks. Even a tiny
 * parts-per-million difference eventually consumes the whole live buffer when
 * a Robot source runs for hours. Smooth arrival phase over roughly ten seconds
 * and correct a source deficit only beyond a two-millisecond deadband, at no
 * more than one sample per input frame. A source legitimately buffered ahead
 * is left untouched. This is an inaudible sample-rate trim, not a jump in the
 * Song timeline.
 */
const BACKING_CLOCK_ERROR_ALPHA = 0.002;

const BACKING_CLOCK_DEADBAND_MS = 2;

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

/**
 * Real Mic history handed to concealment. Fifty milliseconds holds three
 * periods even at the 60 Hz lower pitch bound; a little extra room keeps the
 * pitch correlation window independent from that variation history.
 */
const MIC_CONCEALMENT_HISTORY_MS = 60;

/**
 * Unemitted real audio concealment needs in front of a hole: its 4 ms join,
 * plus the limiter's 3 ms look-ahead that may already have inspected it.
 */
const MIC_CONCEALMENT_JOIN_GUARD_MS = 8;

/** Where one frame reads the Mic, and how the read head got there from the frame before. */
type MicReadPlan = {
  startSample: number;
  /** The advance the previous frame was actually heard at; null before any audible history. */
  previouslyEmittedAdvanceSamples: number | null;
  previousAdvanceSamplesExact: number;
  advanceSamplesExact: number;
  advanceSamples: number;
  micReadStart: number;
  /** A bounded runtime correction moved the read head, so the frame is read at a slewed rate. */
  boundedRuntimeAdvanceMoved: boolean;
  /** An immediate jump with real audio on both legs, so it is crossfaded. */
  canCrossfadeReadHeadJump: boolean;
  crossfadeSamples: number;
};

/** Where a batch of ingested samples landed on the shared session timeline. */
export type IngestResult = {
  samples: Int16Array;
  /** Session sample index of the first sample, in mix-rate samples. */
  start: number;
  /** An established capture clock was replaced before this batch was placed. */
  captureRestarted: boolean;
};

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

  private readonly mic = emptyPcmTimeline();
  private readonly backing = emptyPcmTimeline();

  private running = false;
  private startedAt = 0;
  private frameIndex = 0;
  private sessionGeneration = 0;

  private readonly micGain: MicGainRamp;
  private alignmentState: AlignmentState = {
    networkCompensationMs: 0,
    calibratedMicLagMs: null,
    fineTuneMs: 0,
  };
  /** Desired live drift correction while the currently applied lag slews there. */
  private calibratedMicLagTargetMs: number | null = null;
  /**
   * Folded Mic loss taken back out of the timeline from under the calibration
   * in force, which was measured with it in place: the calibration reads that
   * much too far ahead until the next measurement (see foldConfirmedMicCaptureLoss).
   */
  private calibrationUnfoldedSamples = 0;
  /**
   * Actual Mic advance trajectory emitted at the end of the previous frame.
   * This is deliberately separate from alignmentState: an immediate authority
   * update can replace alignmentState between frames, but continuity still has
   * to know where the audible read head came from.
   */
  private lastEmittedMicAdvanceSamples: number | null = null;
  /** Whether the preceding emitted Mic frame was backed by real source PCM. */
  private lastEmittedMicFrameComplete = false;
  /**
   * Mic frontier safety can deliberately move the read head backwards through
   * retained history. Remember the actual source position last emitted so a
   * capture-clock seam is de-clicked every time the audible trajectory crosses
   * it, not only the first time the mixer ever encountered that position.
   */
  private lastEmittedMicSourceSample: number | null = null;
  /**
   * In-band capture-clock restarts cannot retire queued old PCM at ingest time.
   * Keep every unread old-capture frontier in order: more than one restart can
   * arrive before the mix read head reaches the first boundary.
   */
  private readonly micCaptureRestartBoundaries = new CaptureRestartBoundaries();
  private readonly backingCaptureRestartBoundaries = new CaptureRestartBoundaries();
  /** Proven raw-input flat tops of the Mic, on its retained session timeline. */
  private readonly micInputClipping = new MicInputClipping();
  /**
   * Audible edges of each source at the mix output: replacement transitions,
   * and missing-source fades that a timeline which is contiguous again (late
   * PCM filled what an earlier frame emitted as silence) cannot rewrite.
   */
  private readonly micEdge: SourceOutputEdge;
  private readonly backingEdge: SourceOutputEdge;
  private readonly sourceEdgeFadeSamples: number;

  private micStarvedFrames = 0;
  private backingStarvedFrames = 0;
  /** Consecutive emitted frames missing real source samples, whether a gap or frontier starvation. */
  private micUnplayableRunFrames = 0;
  private backingUnplayableRunFrames = 0;
  private clippedSamples = 0;
  private limitedSamples = 0;
  private heavyLimitedSamples = 0;

  private readonly micLimiter: MicLimiter;
  /**
   * A capture boundary owns fresh limiter dynamics, but a hot replacement must
   * not start blindly at unity. Seed from that capture's own look-ahead on the
   * first real audible sample instead of inheriting the retired capture.
   */
  private micLimiterResetPending = false;

  private readonly micRawMeter: MicRawMeter;
  private micHeadroomMs = 0;
  private micConcealedSamples = 0;
  /** Timeline position where the current Mic capture generation's audio begins. */
  private micCaptureOriginSample: number | null = null;
  /** Holds the Mic read head inside audio that has arrived. */
  private readonly micFrontier: MicFrontierCorrection;
  private readonly micClockTrim: MicClockTrim;
  private backingHeadroomMs = 0;

  constructor(options: AudioSessionOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs;
    this.frameSamples = Math.round((options.sampleRate * options.frameMs) / 1000);
    this.prebufferMs = options.prebufferMs;
    this.micGain = new MicGainRamp(options.sampleRate);
    this.micLimiter = new MicLimiter(options.sampleRate);
    this.micRawMeter = new MicRawMeter(options.sampleRate);
    this.bus = new MixBus({
      sampleRate: options.sampleRate,
      backingGain: options.backingGain,
      voiceCeiling: this.micLimiter.ceiling,
    });
    this.sourceEdgeFadeSamples = Math.max(
      1,
      Math.round((SOURCE_GAP_DECLICK_MS * options.sampleRate) / 1000),
    );
    this.micEdge = new SourceOutputEdge(this.sourceEdgeFadeSamples);
    this.backingEdge = new SourceOutputEdge(this.sourceEdgeFadeSamples);
    this.retentionMs = options.retentionMs;
    this.retentionSamples = Math.round((options.retentionMs * options.sampleRate) / 1000);
    this.backingRetentionMs = options.backingRetentionMs ?? 1_000;
    this.backingRetentionSamples = Math.round((this.backingRetentionMs * options.sampleRate) / 1000);
    this.micFrontier = new MicFrontierCorrection({
      sampleRate: options.sampleRate,
      frameMs: options.frameMs,
      frameSamples: this.frameSamples,
      lookaheadSamples: this.micLimiter.lookaheadSamples,
      safetyMs: ADVANCE_SAFETY_MS,
      slewFraction: RUNTIME_CALIBRATION_SLEW_FRACTION,
    });
    this.micClockTrim = new MicClockTrim(options.sampleRate);
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
    return this.running ? this.micHeadroomMs : null;
  }

  /** Samples of real Mic holes filled by concealment since the session began. */
  get micConcealedSampleCount() {
    return this.micConcealedSamples;
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
    return this.micUnplayableRunFrames <= Math.ceil(ADVANCE_SAFETY_MS / this.frameMs);
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
    this.alignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
    this.calibratedMicLagTargetMs = null;
    this.calibrationUnfoldedSamples = 0;
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
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
    this.calibratedMicLagTargetMs = this.alignmentState.calibratedMicLagMs;
    this.bus.reset();
    this.micGain.reset();
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

  get micGainDb() {
    return this.micGain.targetDb;
  }

  setMicGainDb(value: number) {
    this.micGain.setTargetDb(value, this.running);
  }

  get alignment(): AlignmentState {
    return { ...this.alignmentState };
  }

  /** Current target, equal to the applied lag when no runtime slew is pending. */
  get calibratedMicLagTarget() {
    return this.calibratedMicLagTargetMs;
  }

  /** Immediate authority change used by existing initial/manual/robot semantics. */
  setAlignment(patch: Partial<AlignmentState>) {
    this.alignmentState = { ...this.alignmentState, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'calibratedMicLagMs')) {
      this.calibratedMicLagTargetMs = patch.calibratedMicLagMs ?? null;
    }
  }

  /**
   * Changes only the target. `mixFrame` advances the applied read head gradually
   * so live validation cannot skip/repeat the full correction in one frame.
   */
  slewCalibratedMicLagTo(targetMs: number) {
    if (!Number.isFinite(targetMs)) return false;
    const current = this.alignmentState.calibratedMicLagMs;
    if (current === null || !this.running) {
      const changed = current !== targetMs || this.calibratedMicLagTargetMs !== targetMs;
      this.setAlignment({ calibratedMicLagMs: targetMs });
      return changed;
    }
    if (this.calibratedMicLagTargetMs === targetMs) return false;
    this.calibratedMicLagTargetMs = targetMs;
    return true;
  }

  /** What the alignment asks for, before the buffer's limits are applied. */
  get requestedMicAdvanceMs() {
    const calibrated = this.alignmentState.calibratedMicLagMs;
    const base = calibrated === null
      ? this.alignmentState.networkCompensationMs
      : calibrated - (this.calibrationUnfoldedSamples / this.sampleRate) * 1000;
    return base - this.alignmentState.fineTuneMs;
  }

  /** What the configured buffers can afford, before the live frontier is known. */
  private budgetedMicAdvanceMs(requestedMicAdvanceMs = this.requestedMicAdvanceMs) {
    // Never past zero in either direction: a buffer too small to afford any
    // read-ahead means no read-ahead, not a shove the other way.
    const ahead = Math.max(0, this.prebufferMs - ADVANCE_SAFETY_MS);
    const behind = Math.max(0, this.retentionMs - ADVANCE_SAFETY_MS);
    return Math.max(-behind, Math.min(ahead, requestedMicAdvanceMs));
  }

  /** How far back the retained microphone history allows the read head to sit. */
  private maximumMicReadBehindMs() {
    return Math.max(0, this.retentionMs - ADVANCE_SAFETY_MS);
  }

  /**
   * Milliseconds the mixer actually reads ahead in the microphone timeline.
   *
   * A measurement larger than the buffers can absorb is clamped rather than
   * obeyed: obeying it reads past the end of the microphone history and the
   * vocal disappears entirely, where clamping leaves it audible but late. Both
   * are wrong, and only one of them can be heard and diagnosed. The difference
   * from `requestedMicAdvanceMs` is what says the buffer is too small.
   *
   * The buffer budget alone is not enough to keep that promise. It assumes the
   * microphone timeline runs ahead of the mix clock by roughly the prebuffer,
   * and a capture that joined late or never caught up breaks that assumption:
   * the read head then lands past everything that has arrived, `readPcmRange` pads
   * the frame with zeros, and because both timelines advance at the mix rate
   * afterwards the deficit is constant. Nothing closes it, so a single
   * alignment change silences the microphone for as long as the room stays up.
   * The frontier correction (MicFrontierCorrection) keeps the read head behind the
   * frontier that actually exists.
   */
  private appliedMicAdvanceForRequestedMs(
    requestedMicAdvanceMs: number,
    frontierCorrectionSamples = this.micFrontier.correctionSamples,
  ) {
    const corrected = this.budgetedMicAdvanceMs(requestedMicAdvanceMs)
      - (frontierCorrectionSamples / this.sampleRate) * 1000;
    return Math.max(-this.maximumMicReadBehindMs(), corrected);
  }

  get appliedMicAdvanceMs() {
    return this.appliedMicAdvanceForRequestedMs(this.requestedMicAdvanceMs);
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
    this.calibrationUnfoldedSamples = 0;
    this.micFrontier.noteCalibrationMeasured();
  }

  /** The most frontier correction the retained history lets the read head use. */
  private micFrontierCorrectionCapSamples() {
    const budgeted = Math.round((this.budgetedMicAdvanceMs() * this.sampleRate) / 1000);
    const behind = Math.round((this.maximumMicReadBehindMs() * this.sampleRate) / 1000);
    return budgeted + behind;
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
      this.rebaseMicTimeline(shift);
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
    this.calibrationUnfoldedSamples += measuredAcross;
    const advanceAfter = this.budgetedMicAdvanceMs();
    this.rebaseMicTimeline(-unfold);
    // The advance itself moved back by up to the part measured across, so the
    // correction holds only what the advance did not.
    this.micFrontier.release(Math.round(((advanceBefore - advanceAfter) * this.sampleRate) / 1000));
    this.micFrontier.unfolded(unfold, correctionBefore, measuredAcross);
  }

  /**
   * Moves the whole Mic timeline `shift` samples later and takes the same
   * amount off the frontier correction, so every frame reads exactly the audio
   * it would have read anyway. Only bookkeeping moves: the retained history,
   * the capture anchor and every position kept relative to them shift together.
   */
  private rebaseMicTimeline(shift: number) {
    for (const chunk of this.mic.chunks) chunk.start += shift;
    this.mic.totalSamples += shift;
    this.mic.originOffset += shift;
    this.micCaptureRestartBoundaries.rebase(shift);
    this.micInputClipping.shift(shift);
    if (this.micCaptureOriginSample !== null) this.micCaptureOriginSample += shift;
    if (this.lastEmittedMicSourceSample !== null) this.lastEmittedMicSourceSample += shift;
    // The read position is the frame start plus the advance, so the advance
    // moves with the audio it was reading.
    if (this.lastEmittedMicAdvanceSamples !== null) this.lastEmittedMicAdvanceSamples += shift;
    this.micFrontier.rebase(shift);
  }

  /** Holds the microphone read head behind the samples that have actually arrived. */
  private updateMicFrontierCorrection(startSample: number) {
    this.micFrontier.update({
      expected: this.bus.micExpected,
      frontier: this.mic.totalSamples,
      earliestRetained: this.mic.chunks[0]?.start ?? null,
      startSample,
      appliedAdvanceSamples: Math.round((this.appliedMicAdvanceMs * this.sampleRate) / 1000),
      capSamples: this.micFrontierCorrectionCapSamples(),
    });
  }

  ingestMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    const previousTotalSamples = this.mic.totalSamples;
    const previousChunk = this.mic.chunks.at(-1) ?? null;
    const previousGeneration = this.mic.generation;
    const previousSourceRate = this.mic.sourceRate;
    const previousSourceFrontier = this.mic.sourceFrontier;
    const result = this.ingest(this.mic, frame, sourceRate, nowMs, false, true);
    const currentChunk = this.mic.chunks.at(-1) ?? null;
    const addedChunk = currentChunk !== null && currentChunk !== previousChunk;
    const captureClockChanged = result.captureRestarted
      || previousGeneration !== this.mic.generation
      || previousSourceRate !== this.mic.sourceRate;
    if (captureClockChanged || (addedChunk && !previousChunk)) {
      // Where this capture's own audio begins: its first chunk, or, when the
      // whole first packet lay behind audio already retained and was trimmed
      // away, the frontier its audio has to follow. Recorded only from the
      // later chunk, the origin stayed with the retiring capture, and
      // concealment learned a pitch period across the seam between them.
      this.micCaptureOriginSample = addedChunk ? currentChunk.start : this.mic.totalSamples;
    }

    const positioned = frame.firstSampleIndex !== null;
    const sourceContinuous = Boolean(
      positioned
      && sourceRate
      && !result.captureRestarted
      && previousGeneration === frame.generation
      && previousSourceRate === sourceRate
      && previousSourceFrontier === frame.firstSampleIndex
    );
    if (!sourceContinuous) this.micInputClipping.resetRun();
    if (
      positioned
      && sourceRate
      && result.samples.length > 0
    ) {
      this.micInputClipping.observe(
        frame,
        (sourceSample) => this.micSourceSampleToSessionSample(sourceSample, sourceRate),
        sourceContinuous ? null : result.start,
      );
    }
    if (result.captureRestarted && this.running) {
      this.micCaptureRestartBoundaries.queue(previousTotalSamples);
    }

    // Raw level belongs to the acoustic capture. A generation/source-clock
    // replacement must not inherit the previous device or singer's meter decay.
    // Limiter state is different: old capture PCM may still be queued, so that
    // resets only when the audible read head reaches the retained boundary.
    if (result.captureRestarted) this.micRawMeter.reset();

    // Meter only samples attributable to this source frame. A streaming
    // resampler may prepend one completed target sample that belongs to the
    // previous source packet; counting it again here would double-charge the
    // packet boundary in capture diagnostics.
    this.micRawMeter.observe(result.samples);

    // Only same-capture positioned holes are edited in the retained timeline.
    // A capture-clock restart is an authority boundary whose raw replacement
    // samples stay exact; bind-time replacement edges are tapered at mix output.
    const startsAfterGap = Boolean(
      !result.captureRestarted
      && previousChunk
      && currentChunk
      && currentChunk !== previousChunk
      && currentChunk.samples.length > 0
      && currentChunk.start > previousTotalSamples
    );
    if (startsAfterGap && previousChunk && currentChunk) {
      if (!this.concealMicGap(previousChunk, currentChunk, previousTotalSamples)) {
        this.declickSourceGap(previousChunk, currentChunk.samples, this.firstUnheardMicSample());
      }
    }
    return result;
  }

  /**
   * Fills a proven same-capture hole with pitch-synchronous repetition instead
   * of silence. The hole's evidence is unchanged: `gapSamples` still counts it
   * and every evidence reader treats the concealed chunk as missing, so Take
   * quality, playability and calibration see exactly the loss that happened.
   * Only the audible output differs.
   */
  private concealMicGap(previousChunk: PcmChunk, currentChunk: PcmChunk, gapStart: number) {
    if (!previousChunk.positioned || !currentChunk.positioned) return false;
    // Concealment rewrites the last few milliseconds before the hole so the
    // repetition joins without a step. Once the read head has emitted those
    // samples the join cannot happen, and the output-side frontier edge already
    // owns continuity from what was actually heard - keep that path.
    const emitted = this.lastEmittedMicSourceSample;
    const guardSamples = Math.round((MIC_CONCEALMENT_JOIN_GUARD_MS * this.sampleRate) / 1000);
    if (emitted !== null && emitted >= gapStart - guardSamples) return false;
    const gapSamples = currentChunk.start - gapStart;
    const historyLength = gapStart - this.micConcealmentHistoryStart(gapStart);
    if (gapSamples <= 0 || historyLength <= 0) return false;
    const history = readPcmRange(this.mic, gapStart - historyLength, historyLength);
    // Copy on write. The joins only change what the mix will read: the PCM the
    // ingest result already handed to calibration, validation and meters stays
    // exactly what arrived.
    const previous = previousChunk.samples.slice();
    const next = currentChunk.samples.slice();
    const concealment = concealGap(
      history,
      previous,
      next,
      gapSamples,
      { sampleRate: this.sampleRate },
    );
    if (!concealment) return false;
    previousChunk.samples = previous;
    currentChunk.samples = next;

    const chunks = this.mic.chunks;
    chunks.splice(chunks.length - 1, 0, {
      start: gapStart,
      samples: concealment.fill,
      positioned: true,
      concealed: true,
    });
    this.micConcealedSamples += concealment.fill.length;
    // Without a blend the repetition has faded to silence by the end of the
    // hole (a long hole, or one exactly as long as the fade). Returning from
    // that silence is an ordinary source edge.
    if (concealment.blendedNextSamples === 0) this.fadeInSourceEdge(currentChunk.samples);
    return true;
  }

  /**
   * Oldest sample concealment may learn a period from: contiguous audio of the
   * current acoustic capture only. A pitch cycle spliced across a capture
   * restart or an earlier hole is not a period of anything the singer sang.
   */
  private micConcealmentHistoryStart(gapStart: number) {
    const floor = Math.max(
      0,
      gapStart - Math.round((MIC_CONCEALMENT_HISTORY_MS * this.sampleRate) / 1000),
      this.micCaptureOriginSample ?? 0,
    );
    const chunks = this.mic.chunks;
    let start = gapStart;
    // The last chunk is the one that just proved the hole.
    for (let index = chunks.length - 2; index >= 0 && start > floor; index -= 1) {
      const chunk = chunks[index];
      if (
        !chunk.positioned
        || chunk.concealed
        || chunk.start + chunk.samples.length !== start
      ) break;
      start = chunk.start;
    }
    return Math.max(start, floor);
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
      this.declickSourceGap(previousChunk, currentChunk.samples, this.frameIndex * this.frameSamples);
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
    this.micLimiterResetPending = true;
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
      micStarvedFrames: this.micStarvedFrames,
      backingStarvedFrames: this.backingStarvedFrames,
      micHeadroomMs: Math.round(this.micHeadroomMs),
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
    this.micStarvedFrames = 0;
    this.backingStarvedFrames = 0;
    this.micUnplayableRunFrames = 0;
    this.backingUnplayableRunFrames = 0;
    this.clippedSamples = 0;
    this.limitedSamples = 0;
    this.micRawMeter.reset();
    this.micHeadroomMs = 0;
    this.backingHeadroomMs = 0;
    // These are audio state, not just diagnostics. Carrying gain reduction into
    // a new epoch makes the beginning of the next take inherit the previous
    // singer's last transient and can attenuate it for hundreds of milliseconds.
    this.resetMicLimiterState();
    this.micEdge.reset();
    this.backingEdge.reset();
    this.lastEmittedMicSourceSample = null;
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
      this.lastEmittedMicSourceSample = null;
      this.micCaptureRestartBoundaries.clear();
      this.micInputClipping.clear();
    } else if (timeline === this.backing) {
      this.backingCaptureRestartBoundaries.clear();
    }
    resetPcmTimeline(timeline);
  }

  private micSourceSampleToSessionSample(sourceSample: number, sourceRate: number) {
    return Math.ceil((sourceSample * this.sampleRate) / sourceRate) + this.mic.originOffset;
  }

  /** Capture-scoped detector state; cumulative limiter evidence stays intact. */
  private resetMicLimiterState() {
    this.micLimiter.reset();
    this.micLimiterResetPending = false;
  }

  /**
   * Seeds limiter detector/gain from one already-buffered future window.
   *
   * This is used only at semantic edges where the previous detector state no
   * longer describes the next audible signal. It does not charge cumulative
   * limited-sample evidence; only emitted samples do.
   */
  private seedMicLimiterFromWindow(
    samples: Int16Array,
    fromOffset: number,
    toOffset: number,
    currentMicGainDb: number,
  ) {
    const end = Math.min(samples.length - 1, Math.max(fromOffset, toOffset));
    let peak = 0;
    for (let offset = fromOffset; offset <= end; offset += 1) {
      const gainDb = offset === fromOffset
        ? currentMicGainDb
        : this.micGain.projectDb(offset - fromOffset);
      const magnitude = Math.abs(samples[offset]! / 32768) * (10 ** (gainDb / 20));
      if (magnitude > peak) peak = magnitude;
    }

    this.micLimiter.seedPeak(peak);
  }

  /**
   * Starts a new capture's limiter from that capture's own first look-ahead.
   *
   * A fresh unity gain is unsafe when the replacement itself is already hot:
   * the ordinary attack needs time to converge, while replacement audio starts
   * immediately. Seed directly to the safe target implied by the first detector
   * window.
   */
  private seedMicLimiterForCapture(
    samples: Int16Array,
    fromOffset: number,
    toOffset: number,
    currentMicGainDb: number,
  ) {
    this.seedMicLimiterFromWindow(samples, fromOffset, toOffset, currentMicGainDb);
    this.micLimiterResetPending = false;
  }

  /** Forgets the trajectory the last emitted Mic frame was read along. */
  private resetMicReadContinuity() {
    this.lastEmittedMicAdvanceSamples = null;
    this.lastEmittedMicFrameComplete = false;
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
    if (!sourceRate) {
      return { samples: new Int16Array(0), start: timeline.totalSamples, captureRestarted: false };
    }

    const sourceSampleCount = Math.floor(frame.pcm.byteLength / 2);
    if (sourceSampleCount <= 0) {
      return {
        samples: new Int16Array(0),
        start: timeline.totalSamples,
        captureRestarted: false,
      };
    }
    // Preserve capture-clock anchoring by the source interval's nominal target
    // span, not by how many samples the streaming resampler can emit before it
    // receives the next interpolation endpoint. An upsampled packet may defer
    // one target sample without that sample ceasing to belong to this 20 ms
    // capture interval.
    const nominalResampledSampleCount = sourceRate === this.sampleRate
      ? sourceSampleCount
      : Math.max(1, Math.round((sourceSampleCount * this.sampleRate) / sourceRate));

    let captureRestarted = false;
    let start: number;
    const positioned = frame.firstSampleIndex !== null;
    const hadCaptureClock = timeline.sourceRate !== null;
    const generationChanged = positioned && timeline.generation !== frame.generation;
    const sourceRateChanged = positioned
      && sourceRateDefinesCapture
      && hadCaptureClock
      && !generationChanged
      && timeline.sourceRate !== sourceRate;
    const captureClockChanged = positioned && (generationChanged || sourceRateChanged);
    const sourceContinuous = positioned
      && !captureClockChanged
      && timeline.sourceFrontier === frame.firstSampleIndex;
    const resampled = resamplePcm(
      frame.pcm,
      sourceRate,
      this.sampleRate,
      positioned ? frame.firstSampleIndex : null,
      sourceContinuous ? timeline.resampleTail : [],
      sourceContinuous ? timeline.resampleNextTargetSample : null,
    );
    let samples = resampled.samples;
    let sourceAlignedSampleOffset = resampled.sourceAlignedSampleOffset;
    if (samples.length === 0 && !positioned) {
      return { samples, start: timeline.totalSamples, captureRestarted: false };
    }

    if (!positioned) {
      // No header: the only thing left to do is append at the frontier, which
      // is the old lossy behaviour. Flag it so the UI can say the client is
      // stale rather than letting it degrade invisibly. Its source position is
      // unknowable, so it also breaks positioned resampler continuity.
      timeline.unheadered = true;
      timeline.resampleTail = [];
      timeline.resampleNextTargetSample = null;
      start = timeline.totalSamples;
    } else {
      // Each frame states its own position, so rounding never accumulates and a
      // missing frame leaves a hole of exactly the right length instead of
      // pulling everything after it earlier.
      const streamStart = resampled.targetStart
        ?? Math.ceil((frame.firstSampleIndex! * this.sampleRate) / sourceRate);

      captureRestarted = hadCaptureClock && captureClockChanged;
      if (captureClockChanged) {
        // A fresh capture clock. Anchor it to the session clock; the previous
        // capture's samples keep their own place and simply age out. Mic source
        // rate is part of that clock identity because firstSampleIndex is
        // expressed in source-rate samples even when a client incorrectly
        // reuses its wire generation after rebuilding the capture graph.
        timeline.generation = frame.generation;
        timeline.sourceRate = sourceRate;
        timeline.originOffset = Math.max(
          0,
          this.currentSessionSample(nowMs) - nominalResampledSampleCount,
        ) - streamStart;
        timeline.clockErrorSamples = 0;
        timeline.sourceFrontier = null;
        // The new capture is anchored to the current mix clock, so it starts
        // with healthy headroom and owes nothing to the deficit the correction
        // was covering. Carrying that forward would hold the read head a second
        // behind fresh audio and unwind only at the slew rate - most of a song.
        if (timeline === this.mic) {
          // The read head does not move with the capture: it is still reading
          // the retiring capture's retained audio. Whatever moves it next -
          // dropping a held correction here, or the timing a new capture
          // invalidates, applied before the next frame - must crossfade like
          // any other jump, so read continuity is kept.
          this.micFrontier.reset(this.mic.generation);
          this.micClockTrim.reset();
        }
      } else if (timeline.sourceRate === null) {
        timeline.sourceRate = sourceRate;
      }

      start = streamStart + timeline.originOffset;

      if (trackSourceClock && sourceContinuous && start === timeline.totalSamples) {
        const predictedEnd = start + samples.length;
        const rawError = Math.max(0, this.currentSessionSample(nowMs) - predictedEnd);
        timeline.clockErrorSamples += BACKING_CLOCK_ERROR_ALPHA
          * (rawError - timeline.clockErrorSamples);

        const deadbandSamples = Math.max(
          1,
          Math.round((BACKING_CLOCK_DEADBAND_MS * this.sampleRate) / 1000),
        );
        const correction = timeline.clockErrorSamples > deadbandSamples ? 1 : 0;

        if (correction > 0 && samples.length > sourceAlignedSampleOffset) {
          // Keep any deferred previous-frame interpolation prefix byte-for-byte
          // intact. Only the portion attributable to this source frame is the
          // clock-trim authority for this correction.
          const prefix = samples.subarray(0, sourceAlignedSampleOffset);
          const currentFrame = samples.subarray(sourceAlignedSampleOffset);
          const stretchedCurrentFrame = stretchPcmSpanByOne(currentFrame);
          const stretched = new Int16Array(samples.length + 1);
          stretched.set(prefix, 0);
          stretched.set(stretchedCurrentFrame, sourceAlignedSampleOffset);
          samples = stretched;

          timeline.originOffset += 1;
          timeline.clockErrorSamples -= 1;
          timeline.clockCorrectionSamples += 1;
          start = timeline.totalSamples;
        }
      }

      if (
        timeline === this.mic
        && this.micClockTrim.ppm !== 0
        && timeline.sourceFrontier !== null
      ) {
        const trim = this.micClockTrim.next(
          frame.firstSampleIndex! + sourceSampleCount - timeline.sourceFrontier,
          sourceRate,
          sourceContinuous && start === timeline.totalSamples,
          samples.length - sourceAlignedSampleOffset,
        );
        if (trim !== 0) {
          // As for the Backing correction, a deferred previous-frame
          // interpolation prefix stays byte-for-byte intact.
          const prefix = samples.subarray(0, sourceAlignedSampleOffset);
          const currentFrame = samples.subarray(sourceAlignedSampleOffset);
          const trimmedCurrentFrame = trim > 0
            ? stretchPcmSpanByOne(currentFrame)
            : compressPcmSpanByOne(currentFrame);
          const trimmed = new Int16Array(prefix.length + trimmedCurrentFrame.length);
          trimmed.set(prefix, 0);
          trimmed.set(trimmedCurrentFrame, prefix.length);
          samples = trimmed;
          timeline.originOffset += trim;
          this.micClockTrim.applied(trim);
        }
      }
      const sourceEnd = frame.firstSampleIndex! + sourceSampleCount;
      const previousSourceFrontier = timeline.sourceFrontier;
      const advancesSourceFrontier = captureClockChanged
        || previousSourceFrontier === null
        || sourceEnd > previousSourceFrontier;
      timeline.sourceFrontier = captureClockChanged || previousSourceFrontier === null
        ? sourceEnd
        : Math.max(previousSourceFrontier, sourceEnd);
      if (advancesSourceFrontier) {
        const carried = sourceContinuous ? timeline.resampleTail : [];
        const own: number[] = [];
        for (let index = Math.max(0, sourceSampleCount - RESAMPLE_TAIL_SAMPLES); index < sourceSampleCount; index += 1) {
          own.push(frame.pcm.readInt16LE(index * 2));
        }
        timeline.resampleTail = [...carried, ...own].slice(-RESAMPLE_TAIL_SAMPLES);
        timeline.resampleNextTargetSample = resampled.nextTargetSample;
      }
    }

    if (start < timeline.totalSamples) {
      // Transport ordering is no longer an AudioSession contract. The packet
      // receiver normally prevents late overlap, but this boundary still must
      // not relocate old audio to "now" if a caller violates it. Keep only a
      // genuinely new tail; a fully late packet contributes nothing.
      const overlap = timeline.totalSamples - start;
      if (overlap >= samples.length) {
        return {
          samples: new Int16Array(0),
          start: timeline.totalSamples,
          captureRestarted,
        };
      }
      samples = samples.slice(overlap);
      sourceAlignedSampleOffset = Math.max(0, sourceAlignedSampleOffset - overlap);
      start = timeline.totalSamples;
    } else if (start > timeline.totalSamples && timeline.chunks.length > 0) {
      timeline.gapSamples += start - timeline.totalSamples;
    }

    if (samples.length === 0) return { samples, start, captureRestarted };
    timeline.chunks.push({ start, samples, positioned });
    timeline.totalSamples = start + samples.length;

    // Frame-scoped consumers combine this return value with the current wire
    // frame metadata. Keep a completed deferred prefix on the timeline, but do
    // not attribute that prefix to the new frame whose source clock starts later.
    const consumerOffset = Math.min(samples.length, sourceAlignedSampleOffset);
    return {
      samples: samples.subarray(consumerOffset),
      start: start + consumerOffset,
      captureRestarted,
    };
  }

  /**
   * Reads one microphone frame while a bounded runtime timing correction moves
   * the live read head.
   *
   * Both content-validation slew and frontier-correction release are explicitly
   * limited to about one percent per 20 ms frame. That is a read-rate policy:
   * the frame should consume about 19.8-20.2 ms of microphone audio. Changing
   * only the integer frame start instead skips/repeats about ten samples every
   * 20 ms at 48 kHz, a 50 Hz train of waveform discontinuities that voiced
   * harmonics expose as zipper/buzz.
   *
   * Interpolate a continuous source position across the emitted frame, landing
   * exactly on the new advance at the next frame boundary. Limiter look-ahead
   * then continues at unity rate from that landing point, so it observes the
   * same future waveform the emitted frame is moving toward. Large authority or
   * frontier-acquisition jumps remain deliberate discontinuities and do not use
   * this bounded-rate path.
   */
  private readMicSlewedRange(
    startSample: number,
    fromAdvanceSamples: number,
    toAdvanceSamples: number,
    lookaheadSamples: number,
  ): MicSlewRead {
    return readMicSlewedRange({
      timeline: this.mic,
      frameSamples: this.frameSamples,
      startSample,
      fromAdvanceSamples,
      toAdvanceSamples,
      lookaheadSamples,
      inputClipping: this.micInputClipping,
      captureRestartBoundaries: this.micCaptureRestartBoundaries,
    });
  }

  /**
   * Crossfades an immediate Mic read-head jump without delaying its authority.
   *
   * The first sample continues the previously-emitted trajectory; by the end of
   * this short window the output is entirely the newly-authoritative trajectory.
   * Callers must prove both source windows contain real PCM before using this:
   * a crossfade must never disguise a gap or frontier miss by replaying history.
   */
  private crossfadeMicReadHeadJump(
    startSample: number,
    fromAdvanceSamples: number,
    toStartSample: number,
    current: Int16Array<ArrayBuffer>,
  ) {
    return crossfadeMicReadHeadJump({
      timeline: this.mic,
      frameSamples: this.frameSamples,
      sampleRate: this.sampleRate,
      readHeadCrossfadeMs: MIC_READ_HEAD_CROSSFADE_MS,
      startSample,
      fromAdvanceSamples,
      toStartSample,
      previousSourceSample: this.lastEmittedMicSourceSample,
      current,
      inputClipping: this.micInputClipping,
      captureRestartBoundaries: this.micCaptureRestartBoundaries,
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
  private fadeOutSourceEdge(previous: Int16Array) {
    const fadeOutSamples = Math.min(this.sourceEdgeFadeSamples, previous.length);
    for (let offset = 0; offset < fadeOutSamples; offset += 1) {
      const index = previous.length - fadeOutSamples + offset;
      const weight = fadeOutSamples <= 1
        ? 0
        : (fadeOutSamples - 1 - offset) / (fadeOutSamples - 1);
      previous[index] = Math.round(previous[index] * weight);
    }
  }

  private fadeInSourceEdge(next: Int16Array) {
    const fadeInSamples = Math.min(this.sourceEdgeFadeSamples, next.length);
    for (let index = 0; index < fadeInSamples; index += 1) {
      const weight = fadeInSamples <= 1 ? 0 : index / (fadeInSamples - 1);
      next[index] = Math.round(next[index] * weight);
    }
  }

  /**
   * Tapers the real PCM on both sides of a proven same-capture hole, in the
   * retained timeline. Only audio nobody has heard yet may be rewritten. When
   * part of the taper before the hole was already emitted, rewriting the rest
   * made it start part-way down the ramp - a step against what was heard - so
   * that tail is left alone and the mix output's missing-source edge fades out
   * from what was actually heard instead.
   */
  private declickSourceGap(previous: PcmChunk, next: Int16Array, firstUnheardSample: number) {
    const taper = Math.min(this.sourceEdgeFadeSamples, previous.samples.length);
    const previousEnd = previous.start + previous.samples.length;
    if (previousEnd - Math.max(previous.start, firstUnheardSample) >= taper) {
      this.fadeOutSourceEdge(previous.samples);
    }
    this.fadeInSourceEdge(next);
  }

  /**
   * The first Mic timeline sample the mix has not read. A slewed read
   * interpolates, so the sample after a fractional position was read too.
   */
  private firstUnheardMicSample() {
    return this.lastEmittedMicSourceSample === null
      ? Number.NEGATIVE_INFINITY
      : Math.ceil(this.lastEmittedMicSourceSample) + 1;
  }

  private crossedRetainedMicRestartBoundary(sourceSample: number) {
    const previous = this.lastEmittedMicSourceSample;
    if (previous === null || previous === sourceSample) return false;
    return this.micCaptureRestartBoundaries.firstCrossing(previous, sourceSample) !== null;
  }

  private beginMicCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.crossedRetainedMicRestartBoundary(sourceSample)) return false;
    this.micEdge.beginReplacement();
    return true;
  }

  private beginBackingCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.backingCaptureRestartBoundaries.consumeThrough(sourceSample)) return;
    this.backingEdge.beginReplacement();
  }

  /**
   * One sample through the peak limiter. `detect` is the sample the detector
   * should react to - a few milliseconds ahead of `value` - so the reduction is
   * already in place when the peak arrives.
   */
  private limit(value: number, detect: number, countLimitedSample = true) {
    const limited = this.micLimiter.apply(value, detect);
    if (countLimitedSample && this.micLimiter.limiting) this.limitedSamples += 1;
    if (countLimitedSample && this.micLimiter.heavilyLimiting) this.heavyLimitedSamples += 1;
    return limited;
  }

  private advanceCalibrationSlew() {
    const target = this.calibratedMicLagTargetMs;
    const current = this.alignmentState.calibratedMicLagMs;
    if (target === null || current === null || current === target) return;

    const maximumStepMs = this.frameMs * RUNTIME_CALIBRATION_SLEW_FRACTION;
    const deltaMs = target - current;
    this.alignmentState.calibratedMicLagMs = Math.abs(deltaMs) <= maximumStepMs
      ? target
      : current + Math.sign(deltaMs) * maximumStepMs;
  }

  /**
   * Where this frame reads the Mic, and how the read head moves there from
   * where the previous frame was heard.
   */
  private planMicRead(frameIndex: number): MicReadPlan {
    this.foldConfirmedMicCaptureLoss();
    const previouslyEmittedAdvanceSamples = this.lastEmittedMicAdvanceSamples;
    const previousCalibratedMicLagMs = this.alignmentState.calibratedMicLagMs;
    const previousFrontierCorrectionSamples = this.micFrontier.correctionSamples;
    const previousRequestedMicAdvanceMs = previousCalibratedMicLagMs === null
      ? this.alignmentState.networkCompensationMs - this.alignmentState.fineTuneMs
      : previousCalibratedMicLagMs - this.alignmentState.fineTuneMs;
    const modeledPreviousAdvanceSamplesExact = (
      this.appliedMicAdvanceForRequestedMs(
        previousRequestedMicAdvanceMs,
        previousFrontierCorrectionSamples,
      ) * this.sampleRate
    ) / 1000;
    // Alignment fields can be replaced between emitted frames. In particular,
    // fineTuneMs is immediate authority and therefore cannot be used to
    // reconstruct where the preceding frame was actually heard. Once audible
    // history exists, classify runtime motion from that emitted trajectory.
    const previousAdvanceSamplesExact =
      previouslyEmittedAdvanceSamples ?? modeledPreviousAdvanceSamplesExact;

    this.advanceCalibrationSlew();
    const startSample = frameIndex * this.frameSamples;
    this.updateMicFrontierCorrection(startSample);

    const appliedAdvanceMs = this.appliedMicAdvanceMs;
    const {
      advanceSamplesExact,
      advanceSamples,
      micReadStart,
      boundedRuntimeAdvanceMoved,
      immediateReadHeadJump,
      crossfadeSamples,
      previousTransitionStart,
      readHeadJumped,
    } = classifyMicReadMotion({
      frameSamples: this.frameSamples,
      sampleRate: this.sampleRate,
      startSample,
      previouslyEmittedAdvanceSamples,
      previousAdvanceSamplesExact,
      lastEmittedMicFrameComplete: this.lastEmittedMicFrameComplete,
      appliedAdvanceMs,
      runtimeCalibrationSlewFraction: RUNTIME_CALIBRATION_SLEW_FRACTION,
      readHeadCrossfadeMs: MIC_READ_HEAD_CROSSFADE_MS,
    });
    const previousTransitionEvidence = immediateReadHeadJump
      ? readPcmEvidence(this.mic, previousTransitionStart, crossfadeSamples + 2)
      : null;
    const nextTransitionEvidence = immediateReadHeadJump
      ? readPcmEvidence(this.mic, micReadStart, crossfadeSamples)
      : null;
    const canCrossfadeReadHeadJump = Boolean(
      immediateReadHeadJump
      && previousTransitionEvidence
      && nextTransitionEvidence
      && previousTransitionEvidence.gapSamples === 0
      && previousTransitionEvidence.frontierMissingSamples === 0
      && nextTransitionEvidence.gapSamples === 0
      && nextTransitionEvidence.frontierMissingSamples === 0
    );
    if (readHeadJumped && !canCrossfadeReadHeadJump) {
      // A crossfade needs real PCM on both legs: the previous frame may have
      // ended in a hole or its concealment, or the old leg may run into one.
      // The jump still must not splice. Converge from what was last heard
      // over the same 2 ms edge a capture replacement uses, which replays
      // nothing.
      this.micEdge.beginConvergence();
    }

    return {
      startSample,
      previouslyEmittedAdvanceSamples,
      previousAdvanceSamplesExact,
      advanceSamplesExact,
      advanceSamples,
      micReadStart,
      boundedRuntimeAdvanceMoved,
      canCrossfadeReadHeadJump,
      crossfadeSamples,
    };
  }

  /** How much arrived audio is left past this frame's reads; none left is starvation. */
  private measureHeadroom(plan: MicReadPlan) {
    const {
      startSample,
      previouslyEmittedAdvanceSamples,
      previousAdvanceSamplesExact,
      advanceSamplesExact,
      boundedRuntimeAdvanceMoved,
      canCrossfadeReadHeadJump,
      crossfadeSamples,
    } = plan;
    // Reading ahead can outrun what has actually arrived. readPcmRange pads with
    // zeros when that happens, so without this the vocal simply disappears in
    // chunks and nothing anywhere says why.
    // The limiter's look-ahead reads past the frame, so it is part of what has
    // to have arrived for this frame to be complete.
    const furthestAdvanceSamples = boundedRuntimeAdvanceMoved
      ? Math.max(previousAdvanceSamplesExact, advanceSamplesExact)
      : advanceSamplesExact;
    const ordinaryMicReadEnd =
      startSample + furthestAdvanceSamples + this.frameSamples + this.micLimiter.lookaheadSamples;
    const crossfadeOldReadEnd = canCrossfadeReadHeadJump
      && previouslyEmittedAdvanceSamples !== null
      ? startSample + previouslyEmittedAdvanceSamples + crossfadeSamples + 2
      : Number.NEGATIVE_INFINITY;
    const micReadEnd = Math.ceil(Math.max(ordinaryMicReadEnd, crossfadeOldReadEnd));
    this.micHeadroomMs = ((this.mic.totalSamples - micReadEnd) / this.sampleRate) * 1000;
    this.backingHeadroomMs = ((this.backing.totalSamples - (startSample + this.frameSamples)) / this.sampleRate) * 1000;
    if (this.micHeadroomMs < 0 && this.bus.micExpected) this.micStarvedFrames += 1;
    if (this.backingHeadroomMs < 0 && this.bus.backingExpected) this.backingStarvedFrames += 1;
  }

  /**
   * The Mic samples this frame mixes, with the limiter's look-ahead after
   * them, and the evidence for exactly the source samples that feed them.
   */
  private readMicFrame(plan: MicReadPlan) {
    const {
      startSample,
      previouslyEmittedAdvanceSamples,
      previousAdvanceSamplesExact,
      advanceSamplesExact,
      micReadStart,
      boundedRuntimeAdvanceMoved,
      canCrossfadeReadHeadJump,
    } = plan;
    // The extra tail is the limiter's look-ahead, not audio to be emitted.
    const lookahead = this.micLimiter.lookaheadSamples;
    const micSlew = boundedRuntimeAdvanceMoved
      ? this.readMicSlewedRange(
          startSample,
          previousAdvanceSamplesExact,
          advanceSamplesExact,
          lookahead,
        )
      : null;

    // Take evidence must describe the source samples that actually feed the
    // emitted frame. During a bounded read-rate slew that trajectory is
    // fractional and begins at the previously-emitted advance, not at the new
    // rounded micReadStart. Reuse the exact trajectory evidence produced beside
    // the interpolated PCM; keep the ordinary hot path unchanged.
    const micReadEvidence = micSlew?.evidence
      ?? readPcmEvidence(this.mic, micReadStart, this.frameSamples);
    // Frontier misses are always the trailing portion of ordinary readPcmEvidence().
    // Slew frames instead carry an exact per-output missing mask because a
    // changing read rate can encounter gaps/frontier at non-trailing positions.
    const micFrontierMissingStart = this.frameSamples - micReadEvidence.frontierMissingSamples;
    const micGapMask = !micSlew && micReadEvidence.gapSamples > 0
      ? readPcmGapMask(this.mic, micReadStart, this.frameSamples)
      : null;
    const micInputClippingMask = micSlew?.inputClippingMask
      ?? this.micInputClipping.mask(micReadStart, this.frameSamples);

    let mic = micSlew?.samples
      ?? readPcmRange(this.mic, micReadStart, this.frameSamples + lookahead);
    let crossfadeUnheaderedSamplesDelta = 0;
    let crossfadeMicInputClippedSamplesDelta = 0;
    if (
      canCrossfadeReadHeadJump
      && previouslyEmittedAdvanceSamples !== null
      && !boundedRuntimeAdvanceMoved
    ) {
      const crossfade = this.crossfadeMicReadHeadJump(
        startSample,
        previouslyEmittedAdvanceSamples,
        micReadStart,
        mic,
      );
      mic = crossfade.samples;
      crossfadeUnheaderedSamplesDelta = crossfade.unheaderedSamplesDelta;
      crossfadeMicInputClippedSamplesDelta = crossfade.inputClippedSamplesDelta;
    }
    return {
      samples: mic,
      slew: micSlew,
      evidence: micReadEvidence,
      gapMask: micGapMask,
      frontierMissingStart: micFrontierMissingStart,
      inputClippingMask: micInputClippingMask,
      crossfadeUnheaderedSamplesDelta,
      crossfadeInputClippedSamplesDelta: crossfadeMicInputClippedSamplesDelta,
    };
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

  /**
   * The limiter's look-ahead offset for sample `i`, kept on the old capture
   * while a retained restart boundary lies inside the look-ahead.
   */
  private restartBoundedDetectOffset(
    i: number,
    micSourceSample: number,
    micReadStart: number,
    micSlew: MicSlewRead | null,
    micSlewFrameEndPosition: number,
  ) {
    let detectOffset = i + this.micLimiter.lookaheadSamples;
    const requestedDetectSourceSample = micSlew
      ? detectOffset < this.frameSamples
        ? micSlew.firstPosition + detectOffset * micSlew.rate
        : micSlewFrameEndPosition + (detectOffset - this.frameSamples)
      : micReadStart + detectOffset;
    const detectorRestartBoundary = this.micCaptureRestartBoundaries.firstCrossing(
      micSourceSample,
      requestedDetectSourceSample,
    );
    if (detectorRestartBoundary !== null) {
      // Retain every old-capture look-ahead sample that still exists. This
      // is better than disabling look-ahead wholesale near the boundary:
      // transients on the old capture remain protected without letting the
      // replacement attenuate audio that precedes its semantic ownership.
      while (detectOffset > i) {
        const candidateSourceSample = micSlew
          ? detectOffset < this.frameSamples
            ? micSlew.firstPosition + detectOffset * micSlew.rate
            : micSlewFrameEndPosition + (detectOffset - this.frameSamples)
          : micReadStart + detectOffset;
        if (candidateSourceSample < detectorRestartBoundary) break;
        detectOffset -= 1;
      }
    }

    return detectOffset;
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
    } = this.readMicFrame(plan);
    const {
      samples: song,
      evidence: backingReadEvidence,
      gapMask: backingGapMask,
      frontierMissingStart: backingFrontierMissingStart,
    } = this.readBackingFrame(startSample);
    const lookahead = this.micLimiter.lookaheadSamples;

    this.micUnplayableRunFrames = this.bus.micExpected
      && micReadEvidence.gapSamples + micReadEvidence.frontierMissingSamples > 0
      ? this.micUnplayableRunFrames + 1
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
      if (this.beginMicCaptureRestartEdgeIfDue(micSourceSample)) {
        this.micLimiterResetPending = true;
      }

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

      const micGainDb = this.micGain.advanceDb();
      const micGain = 10 ** (micGainDb / 20);

      // Look-ahead belongs to one acoustic capture. Only pay the extra boundary
      // lookup while retained restart state exists; the ordinary mixer path
      // keeps the same direct +3 ms detector as before.
      const detectOffset = this.micCaptureRestartBoundaries.size > 0
        ? this.restartBoundedDetectOffset(i, micSourceSample, micReadStart, micSlew, micSlewFrameEndPosition)
        : i + lookahead;

      const recoveringFromFullMicSilence = !micAudibleMissing && this.micEdge.silenced;

      if (this.micLimiterResetPending && !micAudibleMissing) {
        this.seedMicLimiterForCapture(
          mic,
          i,
          detectOffset,
          micGainDb,
        );
      } else if (recoveringFromFullMicSilence) {
        // Once a missing-source edge has fully reached silence, the old limiter
        // detector has had time to release and no longer protects a suddenly
        // hot recovery. Seed from the recovered PCM's own look-ahead before the
        // first real sample becomes audible. Very short gaps that never reached
        // silence deliberately keep their existing limiter continuity.
        this.seedMicLimiterFromWindow(
          mic,
          i,
          detectOffset,
          micGainDb,
        );
      }

      // The limiter detector looks ahead in source samples, so it must also see
      // the gain that will apply when that future sample reaches the output.
      const detectMicGain = 10 ** (this.micGain.projectDb(detectOffset - i) / 20);
      let voice = this.limit(
        (mic[i] / 32768) * micGain,
        (mic[detectOffset] / 32768) * detectMicGain,
        !micAudibleMissing,
      );

      // A proven source gap or frontier miss takes over from a capture
      // replacement; structural pre-roll is silent but not source failure, so
      // an active restart transition keeps ownership through it.
      voice = this.micEdge.apply(voice, micEvidenceMissing, micAudibleMissing);
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
      this.lastEmittedMicSourceSample = micSourceSample;
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
    };

    this.lastEmittedMicAdvanceSamples = boundedRuntimeAdvanceMoved
      ? advanceSamplesExact
      : advanceSamples;
    this.lastEmittedMicFrameComplete =
      micReadEvidence.gapSamples === 0
      && micReadEvidence.frontierMissingSamples === 0;

    this.trim(this.mic, startSample - this.retentionSamples);
    this.trim(this.backing, startSample - this.backingRetentionSamples);
    return { frame: output, evidence };
  }
}
