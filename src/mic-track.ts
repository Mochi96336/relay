import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicGainRamp } from './mic-gain-ramp.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { MicLimiter } from './mic-limiter.js';
import { MicRawMeter } from './mic-raw-meter.js';
import type { PcmFrame } from './pcm-frame.js';
import { emptyPcmTimeline, type PcmChunk } from './pcm-timeline.js';
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
    frameMs: number;
    frameSamples: number;
    sourceEdgeFadeSamples: number;
    safetyMs: number;
    slewFraction: number;
  }) {
    const { sampleRate, frameMs, frameSamples, sourceEdgeFadeSamples, safetyMs, slewFraction } = options;
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
}
