import { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicGainRamp } from './mic-gain-ramp.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { MicLimiter } from './mic-limiter.js';
import { MicRawMeter } from './mic-raw-meter.js';
import { emptyPcmTimeline } from './pcm-timeline.js';
import { SourceOutputEdge } from './source-output-edge.js';

/**
 * Per-singer Mic state extracted without changing AudioSession's ingest, render,
 * clock, limiter, or evidence algorithms. The current single-Mic AudioSession
 * aliases these exact objects. Future Choir must give each singer a separate
 * instance while one room owns the backing and final MixBus.
 *
 * This is a STATE boundary, not yet an independent full Mic processor.
 * Read/ingest state that still belongs to AudioSession (read-head history,
 * folded loss, limiter-reset flag etc.) must migrate before reusing it as a
 * production multi-Mic renderer.
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
