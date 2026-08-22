import { performance } from 'node:perf_hooks';

import { analyzeTimingCalibration, type TimingCalibrationAnalysis } from './timing-calibration.js';
import { TimingWindowCollector, type TimingWindow } from './timing-window-collector.js';

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
  /**
   * How far each side has come from the shared origin, in samples.
   *
   * Progress is the overlap of the two, so a window that never fills cannot be
   * told from one filling slowly without seeing which side is short.
   */
  micSpanSamples: number;
  backingSpanSamples: number;
  durationMs: number;
  micLagMs: number | null;
  confidence: number | null;
  segmentLagsMs: number[];
  /** RMS of the raw microphone over the measured window, before any mix gain. */
  micLevelDbfs: number | null;
  backingLevelDbfs: number | null;
  /** Windows that have agreed so far, and how many are needed to apply. */
  windowsAgreed: number;
  windowsNeeded: number;
  /** True while `micLagMs` is a first-window guess agreement has not confirmed yet. */
  provisional: boolean;
  error: string | null;
};

/**
 * Identifies the setup a measurement describes. Every field here is something
 * that can move one stream relative to the other.
 */
export type CalibrationContext = {
  sessionGeneration: number;
  micGeneration: number | null;
  backingGeneration: number | null;
  sourceGeneration: number;
};

export type CalibrationSessionOptions = {
  sampleRate: number;
  durationMs: number;
  timeoutMs: number;
  /** Read when an answer lands, not when collection starts. */
  context: () => CalibrationContext;
  /** Injectable so lifecycle tests do not have to synthesize six real seconds. */
  analyze?: (
    mic: Int16Array,
    backing: Int16Array,
    sampleRate: number,
    maxLagMs?: number,
    signal?: AbortSignal,
  ) => TimingCalibrationAnalysis | PromiseLike<TimingCalibrationAnalysis>;
  /** Fired whenever a window changes applied/settled state. */
  onSettled?: () => void;
  /** How many separately collected windows must agree before confirmation. */
  agreementWindows?: number;
  /** How close windows must land to count as agreeing. */
  agreementToleranceMs?: number;
  /** Confidence required for a first-window provisional application. */
  provisionalConfidence?: number;
  /** Read when a window ends, so the next one gets its own timeout budget. */
  now?: () => number;
  /** How far the analyser may look for a match. */
  maxLagMs?: number;
};

export type ConfirmedCalibrationResult = {
  micLagMs: number;
  confidence: number | null;
  segmentLagsMs: number[];
};

function isPromiseLikeAnalysis(
  value: TimingCalibrationAnalysis | PromiseLike<TimingCalibrationAnalysis>,
): value is PromiseLike<TimingCalibrationAnalysis> {
  return 'then' in value && typeof value.then === 'function';
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
  private readonly provisionalConfidence: number | undefined;
  private readonly now: () => number;
  private readonly maxLagMs: number | undefined;
  private readonly collector: TimingWindowCollector;

  /** Lags from recent windows, kept only as far back as agreement needs. */
  private candidates: number[] = [];

  private phase: CalibrationPhase = 'idle';
  private error: string | null = null;
  private micLagMs: number | null = null;
  private confidence: number | null = null;
  private segmentLagsMs: number[] = [];
  private micLevelDbfs: number | null = null;
  private backingLevelDbfs: number | null = null;
  /** True while `micLagMs` is a first-window guess agreement has not confirmed yet. */
  private provisional = false;
  private startedAt = 0;
  /** Immutable authority snapshot; working retry diagnostics never mutate it. */
  private confirmedResultValue: ConfirmedCalibrationResult | null = null;
  /** Monotonic identity for newly confirmed timing authority. Retries do not change it. */
  private confirmedRevisionValue = 0;
  private analysisPending = false;
  private analysisAbortController: AbortController | null = null;
  /** Invalidates an answer when its collection is restarted or cancelled. */
  private analysisRevision = 0;

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

    const agreementWindows = options.agreementWindows ?? 1;
    if (!Number.isSafeInteger(agreementWindows) || agreementWindows < 1) {
      throw new Error('agreementWindows must be a positive integer.');
    }
    this.agreementWindows = agreementWindows;
    this.agreementToleranceMs = options.agreementToleranceMs ?? 25;
    this.provisionalConfidence = options.provisionalConfidence;
    this.now = options.now ?? (() => performance.now());
    this.maxLagMs = options.maxLagMs;

    // Preserve the old bounded-buffer rule exactly: enough slack for every
    // agreement window plus one window of start skew.
    this.collector = new TimingWindowCollector(
      this.requiredSamples,
      this.requiredSamples * (this.agreementWindows + 1),
    );
  }

  get collecting() {
    return this.phase === 'collecting';
  }

  get result() {
    return this.micLagMs === null
      ? null
      : { micLagMs: this.micLagMs, confidence: this.confidence, segmentLagsMs: this.segmentLagsMs };
  }

  /**
   * The last confirmed measurement, independent of the current phase.
   *
   * A fresh retry deliberately keeps an older confirmed answer applied while
   * collecting, and a failed retry keeps it as history. Working confidence and
   * segment diagnostics belong to the retry and therefore cannot leak into this
   * snapshot until that retry itself earns confirmation.
   */
  get confirmedResult(): ConfirmedCalibrationResult | null {
    if (this.confirmedResultValue === null) return null;
    return {
      micLagMs: this.confirmedResultValue.micLagMs,
      confidence: this.confirmedResultValue.confidence,
      segmentLagsMs: [...this.confirmedResultValue.segmentLagsMs],
    };
  }

  /** Changes only when a new result becomes confirmed; start/fail retries leave it alone. */
  get confirmedRevision() {
    return this.confirmedRevisionValue;
  }

  start(nowMs = performance.now()) {
    this.invalidatePendingAnalysis();
    this.phase = 'collecting';
    this.startedAt = nowMs;
    // A fresh run, so nothing an earlier one measured counts towards agreement.
    // Do not reset `provisional`: an old provisional answer must stay replaceable
    // by a new confident window, while an old confirmed answer stays protected.
    this.candidates = [];
    this.error = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.collector.reset();
  }

  fail(message: string) {
    this.invalidatePendingAnalysis();
    this.phase = 'failed';
    this.error = message;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.collector.reset();
    this.onSettled();
  }

  /**
   * Applies a result measured outside normal content collection, used by the
   * known robot probe path. Probe evidence is unambiguous by construction and
   * therefore settles directly to complete.
   */
  applyExternalResult(result: { micLagMs: number; confidence: number }) {
    this.invalidatePendingAnalysis();
    this.phase = 'complete';
    this.micLagMs = result.micLagMs;
    this.measuredContext = this.context();
    this.confidence = result.confidence;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.error = null;
    this.provisional = false;
    this.candidates = [result.micLagMs];
    this.confirm({ micLagMs: result.micLagMs, confidence: result.confidence, segmentLagsMs: [] });
    this.collector.reset();
    this.onSettled();
  }

  /**
   * Promotes content evidence that has already been independently validated.
   * This is intentionally separate from the robot probe API so the two timing
   * authorities do not share semantics accidentally.
   */
  applyValidatedResult(result: TimingCalibrationAnalysis) {
    this.invalidatePendingAnalysis();
    this.phase = 'complete';
    this.micLagMs = result.micLagMs;
    this.measuredContext = this.context();
    this.confidence = result.confidence;
    this.segmentLagsMs = [...result.segmentLagsMs];
    this.micLevelDbfs = result.micLevelDbfs;
    this.backingLevelDbfs = result.backingLevelDbfs;
    this.error = null;
    this.provisional = false;
    this.candidates = [result.micLagMs];
    this.confirm({
      micLagMs: result.micLagMs,
      confidence: result.confidence,
      segmentLagsMs: result.segmentLagsMs,
    });
    this.collector.reset();
    this.onSettled();
  }

  /** Drops any measurement, for when the thing it described is gone. */
  reset() {
    this.invalidatePendingAnalysis();
    this.phase = 'idle';
    this.error = null;
    this.candidates = [];
    this.micLagMs = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.measuredContext = null;
    this.provisional = false;
    this.confirmedResultValue = null;
    this.collector.reset();
  }

  /** `startSample` is where `AudioSession` placed these samples on its timeline. */
  observeMic(samples: Int16Array, startSample: number) {
    if (!this.collecting || samples.length === 0) return;
    this.collector.observeMic(samples, startSample);
    this.drainReadyWindows();
  }

  observeBacking(samples: Int16Array, startSample: number) {
    if (!this.collecting || samples.length === 0) return;
    this.collector.observeBacking(samples, startSample);
    this.drainReadyWindows();
  }

  /** Gives up on a collection that stopped making progress. */
  tick(nowMs = performance.now()) {
    if (!this.collecting || this.analysisPending || nowMs - this.startedAt <= this.timeoutMs) {
      return false;
    }

    const micMs = Math.round((this.collector.micSpanSamples / this.sampleRate) * 1000);
    const backingMs = Math.round((this.collector.backingSpanSamples / this.sampleRate) * 1000);
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
    const progress = this.collecting
      ? this.analysisPending ? 1 : this.collector.progress
      : this.phase === 'complete'
        ? 1
        : 0;

    return {
      state: this.phase,
      progress,
      micSpanSamples: this.collector.micSpanSamples,
      backingSpanSamples: this.collector.backingSpanSamples,
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
      provisional: this.provisional,
      error: this.error,
    };
  }

  // ---------------------------------------------------------------- internals

  private confirm(result: ConfirmedCalibrationResult) {
    this.confirmedResultValue = {
      micLagMs: result.micLagMs,
      confidence: result.confidence,
      segmentLagsMs: [...result.segmentLagsMs],
    };
    this.confirmedRevisionValue += 1;
  }

  private invalidatePendingAnalysis() {
    this.analysisAbortController?.abort();
    this.analysisAbortController = null;
    this.analysisRevision += 1;
    this.analysisPending = false;
  }

  private drainReadyWindows() {
    while (this.collecting && !this.analysisPending) {
      const window = this.collector.takeReadyWindow();
      if (window === null) break;
      this.finish(window);
    }
  }

  private candidatesAgree() {
    if (this.candidates.length < this.agreementWindows) return false;
    return Math.max(...this.candidates) - Math.min(...this.candidates) <= this.agreementToleranceMs;
  }

  /** How many of the most recent windows still agree with the newest one. */
  private agreeingRun() {
    if (this.candidates.length === 0) return 0;
    let run = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let i = this.candidates.length - 1; i >= 0; i -= 1) {
      minimum = Math.min(minimum, this.candidates[i]);
      maximum = Math.max(maximum, this.candidates[i]);
      if (maximum - minimum > this.agreementToleranceMs) break;
      run += 1;
    }
    return run;
  }

  private finish(window: TimingWindow) {
    try {
      // Holes displace nothing, but they remove evidence. Past a few percent the
      // answer is not worth trusting.
      const gapMs = Math.round(
        (Math.max(window.micGapSamples, window.backingGapSamples) / this.sampleRate) * 1000,
      );
      if (gapMs > MAX_CAPTURE_GAP_MS) {
        throw new Error(
          `Calibration lost ${gapMs} ms of audio while measuring, which would bias the result. `
          + 'Check both connections and start calibration again.',
        );
      }

      const abortController = new AbortController();
      this.analysisAbortController = abortController;
      const result = this.analyze(
        window.mic,
        window.backing,
        this.sampleRate,
        this.maxLagMs,
        abortController.signal,
      );

      if (isPromiseLikeAnalysis(result)) {
        const revision = ++this.analysisRevision;
        this.analysisPending = true;
        void Promise.resolve(result).then(
          (analysis) => this.settlePendingAnalysis(revision, analysis),
          (error: unknown) => this.rejectPendingAnalysis(revision, error),
        );
        return;
      }

      this.analysisAbortController = null;
      this.applyAnalysis(result);
    } catch (error) {
      this.analysisAbortController = null;
      this.rejectAnalysis(error);
    }
  }

  private settlePendingAnalysis(revision: number, result: TimingCalibrationAnalysis) {
    if (revision !== this.analysisRevision || !this.analysisPending) return;
    this.analysisPending = false;
    this.analysisAbortController = null;
    this.applyAnalysis(result);
    this.drainReadyWindows();
  }

  private rejectPendingAnalysis(revision: number, error: unknown) {
    if (revision !== this.analysisRevision || !this.analysisPending) return;
    this.analysisPending = false;
    this.analysisAbortController = null;
    this.rejectAnalysis(error);
  }

  private applyAnalysis(result: TimingCalibrationAnalysis) {
    this.candidates.push(result.micLagMs);
    if (this.candidates.length > this.agreementWindows) this.candidates.shift();

    if (!this.candidatesAgree()) {
      this.confidence = result.confidence;
      this.segmentLagsMs = result.segmentLagsMs;
      this.micLevelDbfs = result.micLevelDbfs;
      this.backingLevelDbfs = result.backingLevelDbfs;
      this.error = null;

      // A confident single window may beat the network fallback while full
      // agreement continues in the background. A confirmed answer from an
      // earlier run remains protected from a new provisional guess.
      if (
        this.provisionalConfidence !== undefined
        && result.confidence >= this.provisionalConfidence
        && (this.micLagMs === null || this.provisional)
      ) {
        this.micLagMs = result.micLagMs;
        this.measuredContext = this.context();
        this.provisional = true;
      }

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
    this.provisional = false;
    this.phase = 'complete';
    this.confirm({
      micLagMs: result.micLagMs,
      confidence: result.confidence,
      segmentLagsMs: result.segmentLagsMs,
    });
    this.collector.reset();
    this.onSettled();
  }

  private rejectAnalysis(error: unknown) {
    this.phase = 'failed';
    this.error = error instanceof Error ? error.message : String(error);
    this.confidence = null;
    this.segmentLagsMs = [];
    this.collector.reset();
    this.onSettled();
  }
}
