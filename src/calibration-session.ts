import { performance } from 'node:perf_hooks';

import { analyzeTimingCalibration, type TimingCalibrationAnalysis } from './timing-calibration.js';

/**
 * Owns the lifecycle of one acoustic timing measurement: collecting six seconds
 * from each side, handing them to the analyser, and holding the answer.
 *
 * Calibration is a tap on the live audio, not a stage in it. Nothing here is on
 * the path a normal take takes; `AudioSession` never asks whether a measurement
 * is in progress. The server feeds this the same samples it feeds the mix, and
 * applies the result to the session's alignment when one lands.
 */

export type CalibrationPhase = 'idle' | 'collecting' | 'complete' | 'failed';

export type CalibrationStatus = {
  state: CalibrationPhase;
  progress: number;
  durationMs: number;
  micLagMs: number | null;
  confidence: number | null;
  segmentLagsMs: number[];
  error: string | null;
};

/** Identifies the setup a measurement describes. */
export type CalibrationContext = {
  sessionGeneration: number;
  micGeneration: number | null;
};

export type CalibrationSessionOptions = {
  sampleRate: number;
  durationMs: number;
  timeoutMs: number;
  /**
   * Read when an answer lands, not when collection starts: the microphone
   * capture that produced the samples is only known once they have arrived.
   */
  context: () => CalibrationContext;
  /** Injectable so lifecycle tests do not have to synthesise six real seconds. */
  analyze?: (mic: Int16Array, backing: Int16Array, sampleRate: number) => TimingCalibrationAnalysis;
  /** Fired when the phase settles on complete or failed. */
  onSettled?: () => void;
};

type Capture = {
  chunks: Int16Array[];
  samples: number;
};

function emptyCapture(): Capture {
  return { chunks: [], samples: 0 };
}

function flatten(capture: Capture, totalSamples: number) {
  const output = new Int16Array(totalSamples);
  let offset = 0;
  for (const chunk of capture.chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

export class CalibrationSession {
  readonly durationMs: number;
  readonly requiredSamples: number;

  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly analyze: NonNullable<CalibrationSessionOptions['analyze']>;
  private readonly context: () => CalibrationContext;
  private readonly onSettled: () => void;

  private phase: CalibrationPhase = 'idle';
  private error: string | null = null;
  private micLagMs: number | null = null;
  private confidence: number | null = null;
  private segmentLagsMs: number[] = [];

  private mic = emptyCapture();
  private backing = emptyCapture();
  private startedAt = 0;

  // The measurement describes one pairing of transports. Remembering which lets
  // the server say the answer is stale instead of applying it to a setup it was
  // never measured against.
  private measuredSessionGeneration: number | null = null;
  private measuredMicGeneration: number | null = null;

  constructor(options: CalibrationSessionOptions) {
    this.sampleRate = options.sampleRate;
    this.durationMs = options.durationMs;
    this.timeoutMs = options.timeoutMs;
    this.requiredSamples = Math.round((options.sampleRate * options.durationMs) / 1000);
    this.analyze = options.analyze ?? analyzeTimingCalibration;
    this.context = options.context;
    this.onSettled = options.onSettled ?? (() => {});
  }

  get collecting() {
    return this.phase === 'collecting';
  }

  get result() {
    return this.micLagMs === null
      ? null
      : { micLagMs: this.micLagMs, confidence: this.confidence, segmentLagsMs: this.segmentLagsMs };
  }

  start(nowMs = performance.now()) {
    this.phase = 'collecting';
    this.startedAt = nowMs;
    this.error = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.clearCapture();
  }

  fail(message: string) {
    this.phase = 'failed';
    this.error = message;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.clearCapture();
    this.onSettled();
  }

  /** Drops any measurement, for when the thing it described is gone. */
  reset() {
    this.phase = 'idle';
    this.error = null;
    this.micLagMs = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.measuredSessionGeneration = null;
    this.measuredMicGeneration = null;
    this.clearCapture();
  }

  observeMic(samples: Int16Array) {
    this.observe(this.mic, samples);
  }

  observeBacking(samples: Int16Array) {
    this.observe(this.backing, samples);
  }

  /** Gives up on a collection that stopped making progress. */
  tick(nowMs = performance.now()) {
    if (this.phase !== 'collecting' || nowMs - this.startedAt <= this.timeoutMs) return false;

    const micMs = Math.round((this.mic.samples / this.sampleRate) * 1000);
    const backingMs = Math.round((this.backing.samples / this.sampleRate) * 1000);
    this.fail(
      `Calibration timed out (mic ${micMs} ms, source ${backingMs} ms of ${this.durationMs} ms). ` +
      'Check that both the phone microphone and the desktop capture are still streaming.',
    );
    return true;
  }

  /**
   * True when the answer was measured against a different live session or a
   * different microphone capture than the one running now.
   */
  isStaleFor(sessionGeneration: number, micGeneration: number | null) {
    if (this.micLagMs === null) return false;
    return this.measuredSessionGeneration !== sessionGeneration
      || this.measuredMicGeneration !== micGeneration;
  }

  status(): CalibrationStatus {
    const captured = Math.min(this.mic.samples, this.backing.samples);
    const progress = this.phase === 'collecting'
      ? Math.max(0, Math.min(1, captured / this.requiredSamples))
      : this.phase === 'complete'
        ? 1
        : 0;

    return {
      state: this.phase,
      progress,
      durationMs: this.durationMs,
      micLagMs: this.micLagMs,
      confidence: this.confidence,
      segmentLagsMs: this.segmentLagsMs,
      error: this.error,
    };
  }

  // ---------------------------------------------------------------- internals

  private clearCapture() {
    this.mic = emptyCapture();
    this.backing = emptyCapture();
  }

  private observe(capture: Capture, samples: Int16Array) {
    if (this.phase !== 'collecting' || samples.length === 0) return;

    const remaining = Math.max(0, this.requiredSamples - capture.samples);
    if (remaining === 0) return;

    const kept = samples.length <= remaining ? samples : samples.slice(0, remaining);
    capture.chunks.push(kept);
    capture.samples += kept.length;

    if (this.mic.samples >= this.requiredSamples && this.backing.samples >= this.requiredSamples) {
      this.finish();
    }
  }

  private finish() {
    try {
      const result = this.analyze(
        flatten(this.mic, this.requiredSamples),
        flatten(this.backing, this.requiredSamples),
        this.sampleRate,
      );
      const context = this.context();
      this.micLagMs = result.micLagMs;
      this.measuredSessionGeneration = context.sessionGeneration;
      this.measuredMicGeneration = context.micGeneration;
      this.confidence = result.confidence;
      this.segmentLagsMs = result.segmentLagsMs;
      this.error = null;
      this.phase = 'complete';
    } catch (error) {
      this.phase = 'failed';
      this.error = error instanceof Error ? error.message : String(error);
      this.confidence = null;
      this.segmentLagsMs = [];
    } finally {
      this.clearCapture();
    }

    this.onSettled();
  }
}
