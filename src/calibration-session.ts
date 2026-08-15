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

/** How much of the six seconds may be missing before the answer is rejected. */
const MAX_CAPTURE_GAP_MS = 300;

export type CalibrationPhase = 'idle' | 'collecting' | 'complete' | 'failed';

export type CalibrationStatus = {
  state: CalibrationPhase;
  progress: number;
  durationMs: number;
  micLagMs: number | null;
  confidence: number | null;
  segmentLagsMs: number[];
  /**
   * RMS of the raw microphone over the measured window, before any mix gain.
   * The analyser computes this to reject a dead microphone; it is also the only
   * measurement of what the phone actually sends, which is what a sensible mic
   * gain has to be derived from.
   */
  micLevelDbfs: number | null;
  backingLevelDbfs: number | null;
  /** Windows that have agreed so far, and how many are needed to apply. */
  windowsAgreed: number;
  windowsNeeded: number;
  error: string | null;
};

/**
 * Identifies the setup a measurement describes. A measurement is only valid
 * for the arrangement it was taken against, and every field here is something
 * that moves one stream relative to the other.
 */
export type CalibrationContext = {
  sessionGeneration: number;
  micGeneration: number | null;
  /**
   * The capture behind the song. A new one can be a different tab, device or
   * output path, so it carries its own delay - a socket reconnect does not.
   */
  backingGeneration: number | null;
  /**
   * Bumped whenever the desktop player is seeked. The follower leaves it alone
   * inside a 450 ms dead band, so where it lands after a seek is arbitrary
   * within that band - which is exactly the offset a calibration measures.
   */
  sourceGeneration: number;
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
  analyze?: (
    mic: Int16Array,
    backing: Int16Array,
    sampleRate: number,
    maxLagMs?: number,
  ) => TimingCalibrationAnalysis;
  /** Fired when the phase settles on complete or failed. */
  onSettled?: () => void;
  /**
   * How many separately collected windows must agree before an answer is
   * applied. One keeps the old single-shot behaviour.
   *
   * The analyser accepts unrelated audio at around half the confidence of a
   * true match, which a person re-running the measurement catches and an
   * unattended server does not. What separates the two is not confidence but
   * repeatability: a false positive lands on a different lag every time, so
   * requiring independent windows to agree rejects it on the second try,
   * whatever it scored on the first.
   */
  agreementWindows?: number;
  /** How close windows must land to count as agreeing. */
  agreementToleranceMs?: number;
  /** Read when a window ends, so the next one gets its own timeout budget. */
  now?: () => number;
  /** How far the analyser may look for a match. */
  maxLagMs?: number;
};

/**
 * Six seconds of one side, kept at the positions the samples actually occupied
 * rather than in the order they turned up.
 *
 * Concatenating on arrival was the old behaviour and it corrupted the
 * measurement two ways, both silent. A dropped frame shortened this side's
 * timeline by its length and a burst delivered together compressed several
 * frames of time into one instant, each shifting the answer by however far it
 * displaced. Worse, starting each side at its own first sample discarded the
 * offset between where the mixer had *anchored* the two timelines - which is
 * part of what the mixer has to correct, so a confident measurement could still
 * leave the mix misaligned.
 */
type Capture = {
  chunks: { start: number; samples: Int16Array }[];
  /** Session sample index this side first covered, or null before anything landed. */
  firstStart: number | null;
  /** One past the last index covered. */
  lastEnd: number;
};

function emptyCapture(): Capture {
  return { chunks: [], firstStart: null, lastEnd: 0 };
}

/**
 * Renders a side onto `origin`, the session index shared by both. Anything the
 * transport never delivered stays zero, so a hole costs the measurement a
 * little correlation instead of shifting everything after it.
 */
function render(capture: Capture, origin: number, total: number) {
  const output = new Int16Array(total);
  let covered = 0;

  for (const { start, samples } of capture.chunks) {
    const offset = start - origin;
    const from = Math.max(0, -offset);
    const at = Math.max(0, offset);
    const length = Math.min(samples.length - from, total - at);
    if (length <= 0) continue;
    output.set(samples.subarray(from, from + length), at);
    covered += length;
  }

  return { samples: output, gapSamples: total - covered };
}

export class CalibrationSession {
  readonly durationMs: number;
  readonly requiredSamples: number;

  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly analyze: NonNullable<CalibrationSessionOptions['analyze']>;
  private readonly context: () => CalibrationContext;
  private readonly onSettled: () => void;
  private readonly agreementWindows: number;
  private readonly agreementToleranceMs: number;
  private readonly now: () => number;
  private readonly maxLagMs: number | undefined;

  /** Lags from recent windows, kept only as far back as agreement needs. */
  private candidates: number[] = [];

  private phase: CalibrationPhase = 'idle';
  private error: string | null = null;
  private micLagMs: number | null = null;
  private confidence: number | null = null;
  private segmentLagsMs: number[] = [];
  private micLevelDbfs: number | null = null;
  private backingLevelDbfs: number | null = null;

  private mic = emptyCapture();
  private backing = emptyCapture();
  private startedAt = 0;

  // The measurement describes one pairing of transports. Remembering which lets
  // the server say the answer is stale instead of applying it to a setup it was
  // never measured against.
  private measuredContext: CalibrationContext | null = null;

  constructor(options: CalibrationSessionOptions) {
    this.sampleRate = options.sampleRate;
    this.durationMs = options.durationMs;
    this.timeoutMs = options.timeoutMs;
    this.requiredSamples = Math.round((options.sampleRate * options.durationMs) / 1000);
    this.analyze = options.analyze ?? analyzeTimingCalibration;
    this.context = options.context;
    this.onSettled = options.onSettled ?? (() => {});
    this.agreementWindows = Math.max(1, options.agreementWindows ?? 1);
    this.agreementToleranceMs = options.agreementToleranceMs ?? 25;
    this.now = options.now ?? (() => performance.now());
    this.maxLagMs = options.maxLagMs;
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
    // A fresh run, so nothing an earlier one measured counts towards agreement.
    this.candidates = [];
    this.error = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.clearCapture();
  }

  fail(message: string) {
    this.phase = 'failed';
    this.error = message;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.clearCapture();
    this.onSettled();
  }

  /** Drops any measurement, for when the thing it described is gone. */
  reset() {
    this.phase = 'idle';
    this.error = null;
    this.candidates = [];
    this.micLagMs = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.measuredContext = null;
    this.clearCapture();
  }

  /** `startSample` is where `AudioSession` placed these samples on its timeline. */
  observeMic(samples: Int16Array, startSample: number) {
    this.observe(this.mic, samples, startSample);
  }

  observeBacking(samples: Int16Array, startSample: number) {
    this.observe(this.backing, samples, startSample);
  }

  /** Gives up on a collection that stopped making progress. */
  tick(nowMs = performance.now()) {
    if (this.phase !== 'collecting' || nowMs - this.startedAt <= this.timeoutMs) return false;

    const micMs = this.spanMs(this.mic);
    const backingMs = this.spanMs(this.backing);
    this.fail(
      `Calibration timed out (mic ${micMs} ms, source ${backingMs} ms of ${this.durationMs} ms). ` +
      'Check that both the phone microphone and the desktop capture are still streaming.',
    );
    return true;
  }

  /** True when the setup has moved on from the one the answer describes. */
  isStaleFor(context: CalibrationContext) {
    if (this.micLagMs === null || this.measuredContext === null) return false;
    return this.measuredContext.sessionGeneration !== context.sessionGeneration
      || this.measuredContext.micGeneration !== context.micGeneration
      || this.measuredContext.backingGeneration !== context.backingGeneration
      || this.measuredContext.sourceGeneration !== context.sourceGeneration;
  }

  status(): CalibrationStatus {
    const progress = this.phase === 'collecting'
      ? Math.max(0, Math.min(1, this.captured / this.requiredSamples))
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
      micLevelDbfs: this.micLevelDbfs,
      backingLevelDbfs: this.backingLevelDbfs,
      // Counts only the run of windows that still agree with the newest one,
      // so a disagreeing window visibly costs the progress it invalidates.
      windowsAgreed: this.phase === 'complete' ? this.agreementWindows : this.agreeingRun(),
      windowsNeeded: this.agreementWindows,
      error: this.error,
    };
  }

  // ---------------------------------------------------------------- internals

  private clearCapture() {
    this.mic = emptyCapture();
    this.backing = emptyCapture();
  }

  /**
   * The session index both sides are rendered from: the later of the two
   * starts, because that is where both actually have audio.
   *
   * Taking the earlier one instead gives the late side a run of silence it was
   * simply not observed for, which reads as an outage and biases the
   * correlation with content that never existed. It does not buy anything
   * either - the offset between the two streams is carried by their session
   * indices, so any shared origin measures the same lag.
   */
  private get origin() {
    if (this.mic.firstStart === null || this.backing.firstStart === null) return null;
    return Math.max(this.mic.firstStart, this.backing.firstStart);
  }

  /** How much of the window both sides now reach. */
  private get captured() {
    const origin = this.origin;
    if (origin === null) return 0;
    return Math.max(0, Math.min(this.mic.lastEnd, this.backing.lastEnd) - origin);
  }

  private candidatesAgree() {
    if (this.candidates.length < this.agreementWindows) return false;
    return Math.max(...this.candidates) - Math.min(...this.candidates) <= this.agreementToleranceMs;
  }

  /** How many of the most recent windows still agree with the newest one. */
  private agreeingRun() {
    const newest = this.candidates.at(-1);
    if (newest === undefined) return 0;
    let run = 0;
    for (let i = this.candidates.length - 1; i >= 0; i -= 1) {
      if (Math.abs(this.candidates[i] - newest) > this.agreementToleranceMs) break;
      run += 1;
    }
    return run;
  }

  private spanMs(capture: Capture) {
    if (capture.firstStart === null) return 0;
    return Math.round(((capture.lastEnd - capture.firstStart) / this.sampleRate) * 1000);
  }

  private observe(capture: Capture, samples: Int16Array, startSample: number) {
    if (this.phase !== 'collecting' || samples.length === 0) return;

    // Enough slack that the shared window is still coverable once the other
    // side turns up, without letting one live stream grow without bound while
    // the other is stalled.
    if (capture.firstStart !== null && startSample - capture.firstStart >= this.requiredSamples * 2) return;

    if (capture.firstStart === null) capture.firstStart = startSample;
    capture.chunks.push({ start: startSample, samples });
    capture.lastEnd = Math.max(capture.lastEnd, startSample + samples.length);

    if (this.captured >= this.requiredSamples) this.finish();
  }

  private finish() {
    const origin = this.origin ?? 0;
    const mic = render(this.mic, origin, this.requiredSamples);
    const backing = render(this.backing, origin, this.requiredSamples);

    try {
      // Holes displace nothing now, but they still remove the evidence the
      // correlation runs on. Past a few percent the answer is not worth trusting.
      const gapMs = Math.round(
        (Math.max(mic.gapSamples, backing.gapSamples) / this.sampleRate) * 1000,
      );
      if (gapMs > MAX_CAPTURE_GAP_MS) {
        throw new Error(
          `Calibration lost ${gapMs} ms of audio while measuring, which would bias the result. `
          + 'Check both connections and start calibration again.',
        );
      }

      const result = this.maxLagMs === undefined
        ? this.analyze(mic.samples, backing.samples, this.sampleRate)
        : this.analyze(mic.samples, backing.samples, this.sampleRate, this.maxLagMs);

      this.candidates.push(result.micLagMs);
      if (this.candidates.length > this.agreementWindows) this.candidates.shift();

      if (!this.candidatesAgree()) {
        // Not an error: one window measured something, and the next has to say
        // the same thing before it is worth believing. Collect another.
        this.confidence = result.confidence;
        this.segmentLagsMs = result.segmentLagsMs;
        this.micLevelDbfs = result.micLevelDbfs;
        this.backingLevelDbfs = result.backingLevelDbfs;
        this.error = null;
        this.clearCapture();
        this.startedAt = this.now();
        this.onSettled();
        return;
      }

      this.micLagMs = result.micLagMs;
      this.measuredContext = this.context();
      this.confidence = result.confidence;
      this.segmentLagsMs = result.segmentLagsMs;
      this.micLevelDbfs = result.micLevelDbfs;
      this.backingLevelDbfs = result.backingLevelDbfs;
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
