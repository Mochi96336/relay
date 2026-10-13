import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicGainRamp } from './mic-gain-ramp.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { MicLimiter } from './mic-limiter.js';
import { MicRawMeter } from './mic-raw-meter.js';
import { emptyPcmTimeline } from './pcm-timeline.js';
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
}
