import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import { concealGap } from './packet-loss-concealment.js';
import { ingestPcmTimeline, type PcmIngestResult } from './pcm-ingest.js';
import { fadeInSourceEdge, declickSourceGap } from './pcm-source-edge-taper.js';
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
import {
  stretchPcmSpanByOne, compressPcmSpanByOne,
} from './pcm-timeline.js';
import type { PcmFrame } from './pcm-frame.js';
import {
  emptyPcmTimeline, readPcmEvidence, readPcmGapMask, readPcmRange, type PcmChunk,
} from './pcm-timeline.js';
import { SourceOutputEdge } from './source-output-edge.js';

/**
 * Only same-capture real PCM can train concealment. Never reuse a cycle
 * across a newly bound device, a previously concealed segment, or an
 * already-emitted audio edge.
 */
const MIC_CONCEALMENT_HISTORY_MS = 60;
const MIC_CONCEALMENT_JOIN_GUARD_MS = 8;

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
  private readonly sourceEdgeFadeSamples: number;
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
    this.sourceEdgeFadeSamples = sourceEdgeFadeSamples;
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
  /**
   * Apply this capture's measured clock trim at an aligned source-packet
   * boundary. A completed resampler prefix belongs to the preceding packet
   * and must remain byte-for-byte untouched.
   *
   * No shared room, backing or other singer state is accessed here.
   */
  trimSourcePacket(input: {
    samples: Int16Array;
    sourceAlignedSampleOffset: number;
    firstSourceSample: number;
    sourceSampleCount: number;
    sourceRate: number;
    contiguous: boolean;
  }): Int16Array {
    const {
      samples, sourceAlignedSampleOffset, firstSourceSample,
      sourceSampleCount, sourceRate, contiguous,
    } = input;
    if (this.clockTrim.ppm === 0 || this.timeline.sourceFrontier === null) {
      return samples;
    }
    const trim = this.clockTrim.next(
      firstSourceSample + sourceSampleCount - this.timeline.sourceFrontier,
      sourceRate,
      contiguous,
      samples.length - sourceAlignedSampleOffset,
    );
    if (trim === 0) return samples;
    const prefix = samples.subarray(0, sourceAlignedSampleOffset);
    const currentFrame = samples.subarray(sourceAlignedSampleOffset);
    const trimmedCurrentFrame = trim > 0
      ? stretchPcmSpanByOne(currentFrame)
      : compressPcmSpanByOne(currentFrame);
    const trimmed = new Int16Array(prefix.length + trimmedCurrentFrame.length);
    trimmed.set(prefix, 0);
    trimmed.set(trimmedCurrentFrame, prefix.length);
    this.timeline.originOffset += trim;
    this.clockTrim.applied(trim);
    return trimmed;
  }

  /**
   * Canonical Mic capture ingestion. The room supplies only its authoritative
   * output clock; source generations, PCM evidence and concealment are local.
   */
  ingestCapture(input: {
    frame: PcmFrame;
    sourceRate: number | null;
    running: boolean;
    roomSampleNow: () => number;
  }): PcmIngestResult {
    const { frame, sourceRate, running, roomSampleNow } = input;
    const previousTotalSamples = this.timeline.totalSamples;
    const previousChunk = this.timeline.chunks.at(-1) ?? null;
    const previousGeneration = this.timeline.generation;
    const previousSourceRate = this.timeline.sourceRate;
    const previousSourceFrontier = this.timeline.sourceFrontier;
    const result = ingestPcmTimeline({
      timeline: this.timeline,
      frame, sourceRate, mixRate: this.sampleRate, roomSampleNow,
      sourceRateDefinesCapture: true,
      onCaptureClockChanged: () => this.onCaptureClockReplaced(),
      trimSourcePacket: (args) => this.trimSourcePacket(args),
    });
    // Source-local capture metadata now belongs to the reusable MicTrack.
    // Only the room supplies its authoritative output clock.
    this.observeIngest({
      frame, sourceRate, running,
      previousTotalSamples, previousChunk,
      previousGeneration, previousSourceRate, previousSourceFrontier,
      result,
    });
    const currentChunk = this.timeline.chunks.at(-1) ?? null;

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
      if (!this.concealCaptureGap(previousChunk, currentChunk, previousTotalSamples)) {
        declickSourceGap(
          previousChunk, currentChunk.samples,
          this.firstUnheardSample(), this.sourceEdgeFadeSamples,
        );
      }
    }
    return result;
  }


  /** Capture-native frame index to this singer's trusted room PCM timeline. */
  sourceSampleToSessionSample(sourceSample: number, sourceRate: number): number {
    return Math.ceil((sourceSample * this.sampleRate) / sourceRate)
      + this.timeline.originOffset;
  }

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
  }) {
    const {
      frame, sourceRate, running,
      previousTotalSamples, previousChunk,
      previousGeneration, previousSourceRate, previousSourceFrontier,
      result,
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
        (sourceSample) => this.sourceSampleToSessionSample(sourceSample, sourceRate),
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



  /** How much arrived audio is left past this frame's reads; none left is starvation. */
  measureReadHeadroom(plan: MicReadPlan, expected: boolean) {
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
      startSample + furthestAdvanceSamples + this.frameSamples + this.limiter.lookaheadSamples;
    const crossfadeOldReadEnd = canCrossfadeReadHeadJump
      && previouslyEmittedAdvanceSamples !== null
      ? startSample + previouslyEmittedAdvanceSamples + crossfadeSamples + 2
      : Number.NEGATIVE_INFINITY;
    const micReadEnd = Math.ceil(Math.max(ordinaryMicReadEnd, crossfadeOldReadEnd));
    this.micHeadroomMs = ((this.timeline.totalSamples - micReadEnd) / this.sampleRate) * 1000;
    if (this.micHeadroomMs < 0 && expected) this.micStarvedFrames += 1;
  }



  /** Capture-scoped detector state; cumulative limiter evidence stays intact. */
  resetLimiterState() {
    this.limiter.reset();
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
        : this.gain.projectDb(offset - fromOffset);
      const magnitude = Math.abs(samples[offset]! / 32768) * (10 ** (gainDb / 20));
      if (magnitude > peak) peak = magnitude;
    }

    this.limiter.seedPeak(peak);
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
    let detectOffset = i + this.limiter.lookaheadSamples;
    const requestedDetectSourceSample = micSlew
      ? detectOffset < this.frameSamples
        ? micSlew.firstPosition + detectOffset * micSlew.rate
        : micSlewFrameEndPosition + (detectOffset - this.frameSamples)
      : micReadStart + detectOffset;
    const detectorRestartBoundary = this.captureRestarts.firstCrossing(
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


  /**
   * Render ONE singer's canonical post-read PCM sample through its own gain,
   * capture-restart-aware lookahead limiter, and source-edge envelope.
   * The room alone sums the returned voice with the shared backing.
   * Never read or write room/other-singer state here.
   */
  processVoiceSample(input: {
    samples: Int16Array;
    i: number;
    sourceSample: number;
    micReadStart: number;
    slew: MicSlewRead | null;
    slewFrameEndPosition: number;
    evidenceMissing: boolean;
    audibleMissing: boolean;
  }): { voice: number; limited: boolean; heavilyLimited: boolean } {
    const {
      samples, i, sourceSample, micReadStart, slew,
      slewFrameEndPosition, evidenceMissing, audibleMissing,
    } = input;
    if (this.beginCaptureRestartEdgeIfDue(sourceSample)) {
      this.micLimiterResetPending = true;
    }

    const micGainDb = this.gain.advanceDb();
    const micGain = 10 ** (micGainDb / 20);
    const detectOffset = this.captureRestarts.size > 0
      ? this.restartBoundedDetectOffset(
          i, sourceSample, micReadStart, slew, slewFrameEndPosition,
        )
      : i + this.limiter.lookaheadSamples;
    const recoveringFromFullMicSilence = !audibleMissing && this.edge.silenced;
    if (this.micLimiterResetPending && !audibleMissing) {
      this.seedMicLimiterForCapture(samples, i, detectOffset, micGainDb);
    } else if (recoveringFromFullMicSilence) {
      this.seedMicLimiterFromWindow(samples, i, detectOffset, micGainDb);
    }
    const detectMicGain = 10 ** (this.gain.projectDb(detectOffset - i) / 20);
    let voice = this.limiter.apply(
      (samples[i] / 32768) * micGain,
      (samples[detectOffset] / 32768) * detectMicGain,
    );
    const limited = !audibleMissing && this.limiter.limiting;
    const heavilyLimited = !audibleMissing && this.limiter.heavilyLimiting;
    voice = this.edge.apply(voice, evidenceMissing, audibleMissing);
    this.lastEmittedMicSourceSample = sourceSample;
    return { voice, limited, heavilyLimited };
  }



  /**
   * Fills a proven same-capture hole with pitch-synchronous repetition instead
   * of silence. The hole's evidence is unchanged: `gapSamples` still counts it
   * and every evidence reader treats the concealed chunk as missing, so Take
   * quality, playability and calibration see exactly the loss that happened.
   * Only the audible output differs.
   */
  concealCaptureGap(previousChunk: PcmChunk, currentChunk: PcmChunk, gapStart: number) {
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
    const history = readPcmRange(this.timeline, gapStart - historyLength, historyLength);
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

    const chunks = this.timeline.chunks;
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
    if (concealment.blendedNextSamples === 0) fadeInSourceEdge(currentChunk.samples, this.sourceEdgeFadeSamples);
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
    const chunks = this.timeline.chunks;
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



  /**
   * Moves the whole Mic timeline `shift` samples later and takes the same
   * amount off the frontier correction, so every frame reads exactly the audio
   * it would have read anyway. Only bookkeeping moves: the retained history,
   * the capture anchor and every position kept relative to them shift together.
   */
  rebaseCaptureTimeline(shift: number) {
    for (const chunk of this.timeline.chunks) chunk.start += shift;
    this.timeline.totalSamples += shift;
    this.timeline.originOffset += shift;
    this.captureRestarts.rebase(shift);
    this.clipping.shift(shift);
    if (this.micCaptureOriginSample !== null) this.micCaptureOriginSample += shift;
    if (this.lastEmittedMicSourceSample !== null) this.lastEmittedMicSourceSample += shift;
    // The read position is the frame start plus the advance, so the advance
    // moves with the audio it was reading.
    if (this.lastEmittedMicAdvanceSamples !== null) this.lastEmittedMicAdvanceSamples += shift;
    this.frontier.rebase(shift);
  }

  /** New authenticated capture generation: drift/frontier debt never survives it. */
  onCaptureClockReplaced() {
    this.frontier.reset(this.timeline.generation);
    this.clockTrim.reset();
  }


}
