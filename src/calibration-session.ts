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

/**
 * How much of the six seconds may be missing before the answer is rejected.
 *
 * Exported because the same bound has to hold anywhere PCM is correlated.
 * `TimingWindowCollector` keeps missing audio as zeros so sample positions stay
 * truthful, which means a window's *length* is its span, not its evidence -
 * so any consumer that reads length alone will happily hand a mostly-silent
 * window to a correlator that cannot possibly match it.
 */
export const MAX_CAPTURE_GAP_MS = 300;

export type CalibrationPhase = 'idle' | 'collecting' | 'complete' | 'failed';

export type CalibrationStatus = {
  state: CalibrationPhase;
  progress: number;
  /** Current content-collector spans; zero outside an in-flight collection. */
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
  /** The only calibration value consumers may apply: confirmed, or an explicitly provisional value. */
  private appliedResultValue: ConfirmedCalibrationResult | null = null;
  private confidence: number | null = null;
  private segmentLagsMs: number[] = [];
  private micLevelDbfs: number | null = null;
  private backingLevelDbfs: number | null = null;
  /** True while the applied result is a first-window guess agreement has not confirmed yet. */
  private provisional = false;
  /** Candidate/provisional work is open until it is promoted or rolled back. */
  private transactionActiveValue = false;
  private startedAt = 0;
  /** Immutable authority snapshot; working retry diagnostics never mutate it. */
  private confirmedResultValue: ConfirmedCalibrationResult | null = null;
  private confirmedContextValue: CalibrationContext | null = null;
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
  /** Context that owns unpromoted content gathered while a preferred probe is viable. */
  private primedContext: CalibrationContext | null = null;

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

  /** The value currently allowed to reach the mixer. */
  get result(): ConfirmedCalibrationResult | null {
    return this.cloneResult(this.appliedResultValue);
  }

  /** True while a candidate is allowed to progress toward promotion. */
  get transactionActive() {
    return this.transactionActiveValue;
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
    // A provisional belongs to the run that created it. Starting a new run is
    // an explicit transaction boundary, so stale provisional authority cannot
    // leak into the retry.
    const revokedProvisional = this.rollbackProvisional();
    this.transactionActiveValue = true;
    this.phase = 'collecting';
    this.startedAt = nowMs;
    this.candidates = [];
    this.error = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.collector.reset();
    if (revokedProvisional) this.onSettled();
  }

  /**
   * Starts a content transaction from evidence collected while a preferred
   * external probe was still viable. Priming is evidence only: it cannot
   * analyze, apply, or promote until this explicit authority handoff.
   */
  startFromPrimed(nowMs = performance.now()) {
    this.invalidatePendingAnalysis();
    const currentContext = this.context();
    // Primed PCM is measurement evidence, not free-floating audio. Never adopt
    // it into a transaction whose session/capture/source identity has changed.
    if (
      this.primedContext === null
      || !this.contextsEqual(this.primedContext, currentContext)
    ) {
      this.collector.reset();
    }
    this.primedContext = null;
    const revokedProvisional = this.rollbackProvisional();
    this.transactionActiveValue = true;
    this.phase = 'collecting';
    this.startedAt = nowMs;
    this.candidates = [];
    this.error = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    if (revokedProvisional) this.onSettled();
    this.drainReadyWindows();
  }

  /** Buffers Mic evidence without opening or promoting a calibration transaction. */
  primeMic(samples: Int16Array, startSample: number) {
    if (this.collecting || this.analysisPending || samples.length === 0) return;
    this.preparePrimedContext();
    this.collector.observeMic(samples, startSample);
  }

  /** Buffers source evidence without opening or promoting a calibration transaction. */
  primeBacking(samples: Int16Array, startSample: number) {
    if (this.collecting || this.analysisPending || samples.length === 0) return;
    this.preparePrimedContext();
    this.collector.observeBacking(samples, startSample);
  }

  /**
   * Read-only, context-fenced PCM for media-transition verification only.
   *
   * Deliberately available while an analysis is pending. `peekRecentWindow()`
   * does not consume or mutate collection state, and `analysisPending` is the
   * moment this session holds the *most* evidence, not the least: a full window
   * has just been collected. Refusing here made a seek arriving in the last
   * moments of a calibration look like it had no evidence at all, so it was
   * classified as a destructive bootstrap remap - invalidating the very run
   * that was about to produce the content authority the seek needed.
   */
  transitionEvidence(maxSamples: number): TimingWindow | null {
    const currentContext = this.context();
    const ownsPrimedEvidence = this.primedContext !== null
      && this.contextsEqual(this.primedContext, currentContext);
    if (!this.collecting && !ownsPrimedEvidence) return null;
    return this.collector.peekRecentWindow(maxSamples);
  }

  /** A destructive source identity change invalidates unpromoted backup evidence. */
  discardPrimedContent() {
    if (this.collecting || this.analysisPending) return;
    this.collector.reset();
    this.primedContext = null;
  }

  /**
   * Records failure of an external preferred candidate while retaining only the
   * independent, unpromoted content backup. Confirmed/applied authority keeps
   * the normal transactional rollback semantics.
   */
  failPreservingPrimed(message: string) {
    this.invalidatePendingAnalysis();
    this.rollbackProvisional();
    this.transactionActiveValue = false;
    this.phase = 'failed';
    this.error = message;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.onSettled();
  }

  /**
   * Opens the transaction used by robot/manual probe calibration.
   *
   * Unlike `reset()`, this deliberately preserves the current confirmed/applied
   * authority while the external candidate is being measured.
   */
  beginExternalRecalibration() {
    this.invalidatePendingAnalysis();
    this.rollbackProvisional();
    this.transactionActiveValue = true;
    this.phase = this.appliedResultValue === null ? 'idle' : 'complete';
    this.error = null;
    this.candidates = [];
    this.collector.reset();
  }

  fail(message: string) {
    this.invalidatePendingAnalysis();
    this.rollbackProvisional();
    this.transactionActiveValue = false;
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
   * Stands a collection down without calling it a failure.
   *
   * Content calibration is a tap on the live audio, so something else taking
   * priority - a Take starting on the same audio this run is measuring - is not
   * evidence that the measurement went wrong. `fail()` would publish an error
   * the room never caused and would be read as a timing problem; this returns
   * the session to its settled phase with the confirmed authority still
   * serving, so the next automatic run starts clean.
   *
   * Only a collection can be stood down. A probe transaction opened by
   * `beginExternalRecalibration()` is never `collecting`, and it owns its own
   * lifecycle.
   */
  abandon() {
    if (!this.collecting) return false;
    this.invalidatePendingAnalysis();
    this.rollbackProvisional();
    this.transactionActiveValue = false;
    this.phase = this.confirmedResultValue === null ? 'idle' : 'complete';
    this.error = null;
    this.candidates = [];
    // Working diagnostics belong to the run that was stood down. Confidence and
    // segment lags revert to whatever the confirmed snapshot earned, so status
    // never reports an abandoned candidate's numbers as the room's answer.
    this.confidence = this.confirmedResultValue?.confidence ?? null;
    this.segmentLagsMs = this.confirmedResultValue === null
      ? []
      : [...this.confirmedResultValue.segmentLagsMs];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.collector.reset();
    this.primedContext = null;
    this.onSettled();
    return true;
  }

  /**
   * Applies a result measured outside normal content collection, used by the
   * known robot probe path. Probe evidence is unambiguous by construction and
   * therefore settles directly to complete.
   */
  applyExternalResult(result: { micLagMs: number; confidence: number }) {
    this.invalidatePendingAnalysis();
    this.phase = 'complete';
    this.confidence = result.confidence;
    this.segmentLagsMs = [];
    this.micLevelDbfs = null;
    this.backingLevelDbfs = null;
    this.error = null;
    this.candidates = [result.micLagMs];
    this.promoteConfirmed(
      { micLagMs: result.micLagMs, confidence: result.confidence, segmentLagsMs: [] },
      this.context(),
    );
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
    this.confidence = result.confidence;
    this.segmentLagsMs = [...result.segmentLagsMs];
    this.micLevelDbfs = result.micLevelDbfs;
    this.backingLevelDbfs = result.backingLevelDbfs;
    this.error = null;
    this.candidates = [result.micLagMs];
    this.promoteConfirmed({
      micLagMs: result.micLagMs,
      confidence: result.confidence,
      segmentLagsMs: result.segmentLagsMs,
    }, this.context());
    this.collector.reset();
    this.onSettled();
  }

  /** Drops any measurement, for when the thing it described is gone. */
  reset() {
    this.invalidatePendingAnalysis();
    this.phase = 'idle';
    this.error = null;
    this.candidates = [];
    this.appliedResultValue = null;
    this.confidence = null;
    this.segmentLagsMs = [];
    this.measuredContext = null;
    this.provisional = false;
    this.transactionActiveValue = false;
    this.confirmedResultValue = null;
    this.confirmedContextValue = null;
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

  /**
   * Drops only unanalysed PCM after a proven media-mapping discontinuity.
   * The calibration transaction and any older confirmed/applied authority stay
   * intact; a collecting transaction simply receives a fresh timeout budget.
   */
  restartWorkingEvidence(nowMs = this.now()) {
    const wasCollecting = this.collecting;
    const hadPrimedEvidence = this.primedContext !== null;
    this.collector.reset();
    this.primedContext = null;
    if (wasCollecting) this.startedAt = nowMs;
    if (wasCollecting || hadPrimedEvidence) this.onSettled();
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
    if (this.appliedResultValue === null || this.measuredContext === null) return false;
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
    const spanForStatus = (spanSamples: number) => !this.collecting
      ? 0
      : this.analysisPending
        ? this.requiredSamples
        : Math.min(this.requiredSamples, spanSamples);

    return {
      state: this.phase,
      progress,
      micSpanSamples: spanForStatus(this.collector.micSpanSamples),
      backingSpanSamples: spanForStatus(this.collector.backingSpanSamples),
      durationMs: this.durationMs,
      micLagMs: this.appliedResultValue?.micLagMs ?? null,
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

  private cloneResult(result: ConfirmedCalibrationResult | null): ConfirmedCalibrationResult | null {
    if (result === null) return null;
    return {
      micLagMs: result.micLagMs,
      confidence: result.confidence,
      segmentLagsMs: [...result.segmentLagsMs],
    };
  }

  private cloneContext(context: CalibrationContext | null): CalibrationContext | null {
    return context === null ? null : { ...context };
  }

  private contextsEqual(left: CalibrationContext, right: CalibrationContext) {
    return left.sessionGeneration === right.sessionGeneration
      && left.micGeneration === right.micGeneration
      && left.backingGeneration === right.backingGeneration
      && left.sourceGeneration === right.sourceGeneration;
  }

  private preparePrimedContext() {
    const currentContext = this.context();
    if (
      this.primedContext === null
      || !this.contextsEqual(this.primedContext, currentContext)
    ) {
      this.collector.reset();
      this.primedContext = this.cloneContext(currentContext);
    }
  }

  /**
   * Commits a new authority in one synchronous promotion. The mixer callback
   * therefore cannot observe a new applied lag paired with an older confirmed
   * snapshot (or vice versa).
   */
  private promoteConfirmed(result: ConfirmedCalibrationResult, context: CalibrationContext) {
    const promoted = this.cloneResult(result)!;
    const promotedContext = this.cloneContext(context)!;
    this.confirmedResultValue = promoted;
    this.confirmedContextValue = promotedContext;
    this.appliedResultValue = this.cloneResult(promoted);
    this.measuredContext = this.cloneContext(promotedContext);
    this.provisional = false;
    this.transactionActiveValue = false;
    this.confirmedRevisionValue += 1;
  }

  /** Revokes only provisional authority, restoring the previous confirmed snapshot if one exists. */
  private rollbackProvisional() {
    if (!this.provisional) return false;
    this.appliedResultValue = this.cloneResult(this.confirmedResultValue);
    this.measuredContext = this.cloneContext(this.confirmedContextValue);
    this.provisional = false;
    return true;
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
        && (this.appliedResultValue === null || this.provisional)
      ) {
        this.appliedResultValue = {
          micLagMs: result.micLagMs,
          confidence: result.confidence,
          segmentLagsMs: [...result.segmentLagsMs],
        };
        this.measuredContext = this.context();
        this.provisional = true;
      }

      this.startedAt = this.now();
      this.onSettled();
      return;
    }

    this.confidence = result.confidence;
    this.segmentLagsMs = result.segmentLagsMs;
    this.micLevelDbfs = result.micLevelDbfs;
    this.backingLevelDbfs = result.backingLevelDbfs;
    this.error = null;
    this.phase = 'complete';
    this.promoteConfirmed({
      micLagMs: result.micLagMs,
      confidence: result.confidence,
      segmentLagsMs: result.segmentLagsMs,
    }, this.context());
    this.collector.reset();
    this.onSettled();
  }

  private rejectAnalysis(error: unknown) {
    this.rollbackProvisional();
    this.transactionActiveValue = false;
    this.phase = 'failed';
    this.error = error instanceof Error ? error.message : String(error);
    this.confidence = null;
    this.segmentLagsMs = [];
    this.collector.reset();
    this.onSettled();
  }
}
