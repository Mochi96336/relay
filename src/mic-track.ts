import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicGainRamp } from './mic-gain-ramp.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { MicLimiter } from './mic-limiter.js';
import { MicRawMeter } from './mic-raw-meter.js';
import {
  readMicSlewedRange, crossfadeMicReadHeadJump, type MicSlewRead,
} from './mic-frame-reader.js';
import { classifyMicReadMotion } from './mic-read-plan.js';
import type { PcmFrame } from './pcm-frame.js';
import {
  emptyPcmTimeline, readPcmEvidence, readPcmGapMask, readPcmRange, type PcmChunk,
} from './pcm-timeline.js';
import { SourceOutputEdge } from './source-output-edge.js';

export type AlignmentState = {
  /** RTT/2 fallback used until an acoustic calibration succeeds. */
  networkCompensationMs: number;
  calibratedMicLagMs: number | null;
  fineTuneMs: number;
};

/**
 * Per-singer Mic state extracted without changing AudioSession's ingest, render,
 * clock, limiter, or evidence algorithms. The current single-Mic AudioSession
 * aliases these exact objects. Future Choir must give each singer a separate
 * instance while one room owns the backing and final MixBus.
 *
 * This is a STATE boundary, not yet an independent full Mic processor.
 * Track-local calibration/read-head history, capture flags and health counters
 * now live alongside these components. The actual ingest/read algorithms
 * still run in AudioSession; this does not yet create a reusable processor.
 */
/** Where one frame reads the Mic, and how the read head got there from the frame before. */
export type MicReadPlan = {
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

export class MicTrack {
  readonly timeline = emptyPcmTimeline();
  readonly gain: MicGainRamp;
  readonly limiter: MicLimiter;
  readonly meter: MicRawMeter;
  readonly captureRestarts = new CaptureRestartBoundaries();
  readonly clipping = new MicInputClipping();
  readonly edge: SourceOutputEdge;
  readonly frontier: MicFrontierCorrection;
  readonly clockTrim: MicClockTrim;
  private readonly prebufferMs: number;
  private readonly retentionMs: number;
  private readonly safetyMs: number;
  private readonly sampleRate: number;
  private readonly frameMs: number;
  private readonly slewFraction: number;
  private readonly frameSamples: number;
  private readonly readHeadCrossfadeMs: number;

  /** Calibration is owned by each singer, not by the room output clock. */
  alignmentState: AlignmentState = {
    networkCompensationMs: 0,
    calibratedMicLagMs: null,
    fineTuneMs: 0,
  };
  calibratedMicLagTargetMs: number | null = null;
  /** Calibration offset accounted for by folded capture loss. */
  calibrationUnfoldedSamples = 0;
  /** Previously emitted per-singer read-head trajectory. */
  lastEmittedMicAdvanceSamples: number | null = null;
  lastEmittedMicFrameComplete = false;
  lastEmittedMicSourceSample: number | null = null;
  /** Own source starvation and concealment evidence. */
  micStarvedFrames = 0;
  micUnplayableRunFrames = 0;
  micHeadroomMs = 0;
  micConcealedSamples = 0;
  /** Capture-specific source origin and limiter restart guard. */
  micLimiterResetPending = false;
  micCaptureOriginSample: number | null = null;


  constructor(options: {
    sampleRate: number;
    prebufferMs: number;
    retentionMs: number;
    frameMs: number;
    frameSamples: number;
    sourceEdgeFadeSamples: number;
    safetyMs: number;
    slewFraction: number;
    readHeadCrossfadeMs: number;
  }) {
    const { sampleRate, frameMs, frameSamples, sourceEdgeFadeSamples, safetyMs, slewFraction } = options;
    this.prebufferMs = options.prebufferMs;
    this.retentionMs = options.retentionMs;
    this.safetyMs = safetyMs;
    this.sampleRate = sampleRate;
    this.frameMs = frameMs;
    this.slewFraction = slewFraction;
    this.frameSamples = frameSamples;
    this.readHeadCrossfadeMs = options.readHeadCrossfadeMs;
    this.gain = new MicGainRamp(sampleRate);
    this.limiter = new MicLimiter(sampleRate);
    this.meter = new MicRawMeter(sampleRate);
    this.edge = new SourceOutputEdge(sourceEdgeFadeSamples);
    this.frontier = new MicFrontierCorrection({
      sampleRate, frameMs, frameSamples,
      lookaheadSamples: this.limiter.lookaheadSamples,
      safetyMs, slewFraction,
    });
    this.clockTrim = new MicClockTrim(sampleRate);
  }

  /**
   * Apply the Mic-specific post-ingest effects after AudioSession places
   * the packet on the authoritative mix-rate timeline.
   *
   * This is the FIRST actual ingest responsibility moved into MicTrack.
   * The caller still owns authenticated packet admission, timeline placement,
   * resampling, clock trim, gap concealment and the output room clock.
   */
  observeIngest(input: {
    frame: PcmFrame;
    sourceRate: number | null;
    running: boolean;
    previousTotalSamples: number;
    previousChunk: PcmChunk | null;
    previousGeneration: number | null;
    previousSourceRate: number | null;
    previousSourceFrontier: number | null;
    result: {
      captureRestarted: boolean;
      samples: Int16Array;
      start: number;
    };
    mapSourceSample: (sourceSample: number, rate: number) => number;
  }) {
    const {
      frame, sourceRate, running,
      previousTotalSamples, previousChunk,
      previousGeneration, previousSourceRate, previousSourceFrontier,
      result, mapSourceSample,
    } = input;
    const currentChunk = this.timeline.chunks.at(-1) ?? null;
    const addedChunk = currentChunk !== null && currentChunk !== previousChunk;
    const captureClockChanged = result.captureRestarted
      || previousGeneration !== this.timeline.generation
      || previousSourceRate !== this.timeline.sourceRate;
    if (captureClockChanged || (addedChunk && !previousChunk)) {
      // First positioned sample of the current acoustic capture, not a
      // retained chunk from a previous device that may still be audible.
      this.micCaptureOriginSample = addedChunk
        ? currentChunk.start : this.timeline.totalSamples;
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
    if (!sourceContinuous) this.clipping.resetRun();
    if (positioned && sourceRate && result.samples.length > 0) {
      this.clipping.observe(
        frame,
        (sourceSample) => mapSourceSample(sourceSample, sourceRate),
        sourceContinuous ? null : result.start,
      );
    }
    if (result.captureRestarted && running) {
      this.captureRestarts.queue(previousTotalSamples);
    }

    // Meter resets immediately on new capture; limiter dynamics are deferred
    // until the audible read head crosses the capture's restart boundary.
    if (result.captureRestarted) this.meter.reset();
    // Only count the PCM attributable to this packet; any completed
    // resampler-tail sample was already handled by ingest().
    this.meter.observe(result.samples);
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
      timeline: this.timeline,
      frameSamples: this.frameSamples,
      startSample,
      fromAdvanceSamples,
      toAdvanceSamples,
      lookaheadSamples,
      inputClipping: this.clipping,
      captureRestartBoundaries: this.captureRestarts,
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
      timeline: this.timeline,
      frameSamples: this.frameSamples,
      sampleRate: this.sampleRate,
      readHeadCrossfadeMs: this.readHeadCrossfadeMs,
      startSample,
      fromAdvanceSamples,
      toStartSample,
      previousSourceSample: this.lastEmittedMicSourceSample,
      current,
      inputClipping: this.clipping,
      captureRestartBoundaries: this.captureRestarts,
    });
  }

  /**
   * The Mic samples this frame mixes, with the limiter's look-ahead after
   * them, and the evidence for exactly the source samples that feed them.
   */
  readMicFrame(plan: MicReadPlan) {
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
    const lookahead = this.limiter.lookaheadSamples;
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
      ?? readPcmEvidence(this.timeline, micReadStart, this.frameSamples);
    // Frontier misses are always the trailing portion of ordinary readPcmEvidence().
    // Slew frames instead carry an exact per-output missing mask because a
    // changing read rate can encounter gaps/frontier at non-trailing positions.
    const micFrontierMissingStart = this.frameSamples - micReadEvidence.frontierMissingSamples;
    const micGapMask = !micSlew && micReadEvidence.gapSamples > 0
      ? readPcmGapMask(this.timeline, micReadStart, this.frameSamples)
      : null;
    const micInputClippingMask = micSlew?.inputClippingMask
      ?? this.clipping.mask(micReadStart, this.frameSamples);

    let mic = micSlew?.samples
      ?? readPcmRange(this.timeline, micReadStart, this.frameSamples + lookahead);
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



  firstUnheardSample() {
    return this.lastEmittedMicSourceSample === null
      ? Number.NEGATIVE_INFINITY
      : Math.ceil(this.lastEmittedMicSourceSample) + 1;
  }

  private crossedRetainedRestartBoundary(sourceSample: number) {
    const previous = this.lastEmittedMicSourceSample;
    if (previous === null || previous === sourceSample) return false;
    return this.captureRestarts.firstCrossing(previous, sourceSample) !== null;
  }

  beginCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.crossedRetainedRestartBoundary(sourceSample)) return false;
    this.edge.beginReplacement();
    return true;
  }

  advanceCalibrationSlew() {
    const target = this.calibratedMicLagTargetMs;
    const current = this.alignmentState.calibratedMicLagMs;
    if (target === null || current === null || current === target) return;

    const maximumStepMs = this.frameMs * this.slewFraction;
    const deltaMs = target - current;
    this.alignmentState.calibratedMicLagMs = Math.abs(deltaMs) <= maximumStepMs
      ? target
      : current + Math.sign(deltaMs) * maximumStepMs;
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
  budgetedMicAdvanceMs(requestedMicAdvanceMs = this.requestedMicAdvanceMs) {
    // Never past zero in either direction: a buffer too small to afford any
    // read-ahead means no read-ahead, not a shove the other way.
    const ahead = Math.max(0, this.prebufferMs - this.safetyMs);
    const behind = Math.max(0, this.retentionMs - this.safetyMs);
    return Math.max(-behind, Math.min(ahead, requestedMicAdvanceMs));
  }

  /** How far back the retained microphone history allows the read head to sit. */
  private maximumMicReadBehindMs() {
    return Math.max(0, this.retentionMs - this.safetyMs);
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
    frontierCorrectionSamples = this.frontier.correctionSamples,
  ) {
    const corrected = this.budgetedMicAdvanceMs(requestedMicAdvanceMs)
      - (frontierCorrectionSamples / this.sampleRate) * 1000;
    return Math.max(-this.maximumMicReadBehindMs(), corrected);
  }

  get appliedMicAdvanceMs() {
    return this.appliedMicAdvanceForRequestedMs(this.requestedMicAdvanceMs);
  }

  frontierCorrectionCapSamples() {
    const budgeted = Math.round((this.budgetedMicAdvanceMs() * this.sampleRate) / 1000);
    const behind = Math.round((this.maximumMicReadBehindMs() * this.sampleRate) / 1000);
    return budgeted + behind;
  }

  /** Updates one Mic frontier using the shared room's sample position. */
  updateFrontierCorrection(startSample: number, expected: boolean) {
    this.frontier.update({
      expected,
      frontier: this.timeline.totalSamples,
      earliestRetained: this.timeline.chunks[0]?.start ?? null,
      startSample,
      appliedAdvanceSamples: Math.round((this.appliedMicAdvanceMs * this.sampleRate) / 1000),
      capSamples: this.frontierCorrectionCapSamples(),
    });
  }

  /**
   * Where this frame reads the Mic, and how the read head moves there from
   * where the previous frame was heard.
   */
  planMicRead(startSample: number, expected: boolean): MicReadPlan {
    const previouslyEmittedAdvanceSamples = this.lastEmittedMicAdvanceSamples;
    const previousCalibratedMicLagMs = this.alignmentState.calibratedMicLagMs;
    const previousFrontierCorrectionSamples = this.frontier.correctionSamples;
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
    this.updateFrontierCorrection(startSample, expected);

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
      runtimeCalibrationSlewFraction: this.slewFraction,
      readHeadCrossfadeMs: this.readHeadCrossfadeMs,
    });
    const previousTransitionEvidence = immediateReadHeadJump
      ? readPcmEvidence(this.timeline, previousTransitionStart, crossfadeSamples + 2)
      : null;
    const nextTransitionEvidence = immediateReadHeadJump
      ? readPcmEvidence(this.timeline, micReadStart, crossfadeSamples)
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
      this.edge.beginConvergence();
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


}
