import { performance } from 'node:perf_hooks';

import {
  analyzeTimingCalibration,
  type TimingCalibrationAnalysis,
  type TimingCalibrationShadowAnalysis,
} from './timing-calibration.js';
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

export type CalibrationPassiveShadowContext = {
  sessionGeneration: number;
  micGeneration: number;
  backingGeneration: number;
  sourceGeneration: number;
};

export type CalibrationPassiveShadowObservation = {
  authoritative: false;
  context: CalibrationPassiveShadowContext;
  originSample: number;
  endSample: number;
  micGapMs: number;
  backingGapMs: number;
  strictPassed: boolean;
  error: string | null;
  result: TimingCalibrationAnalysis | null;
  shadow: TimingCalibrationShadowAnalysis | null;
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
    onShadow?: (shadow: TimingCalibrationShadowAnalysis) => void,
    shadowLowLevel?: boolean,
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
  /**
   * Collect independent content windows even while normal content calibration
   * is not collecting. This is evidence-only and can never reach authority.
   */
  passiveShadowEnabled?: boolean;
  /** Injectable sink for tests/diagnostics. Defaults to one structured log. */
  onPassiveShadow?: (observation: CalibrationPassiveShadowObservation) => void;
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

function passiveShadowContext(context: CalibrationContext): CalibrationPassiveShadowContext | null {
  if (context.micGeneration === null || context.backingGeneration === null) return null;
  return {
    sessionGeneration: context.sessionGeneration,
    micGeneration: context.micGeneration,
    backingGeneration: context.backingGeneration,
    sourceGeneration: context.sourceGeneration,
  };
}

function samePassiveShadowContext(
  a: CalibrationPassiveShadowContext | null,
  b: CalibrationPassiveShadowContext | null,
) {
  return a !== null
    && b !== null
    && a.sessionGeneration === b.sessionGeneration
    && a.micGeneration === b.micGeneration
    && a.backingGeneration === b.backingGeneration
    && a.sourceGeneration === b.sourceGeneration;
}

function passiveShadowLogPayload(observation: CalibrationPassiveShadowObservation) {
  const effective = observation.result ?? observation.shadow?.result ?? null;
  const diagnostics = effective?.diagnostics;
  return {
    source: 'passive-window',
    authoritative: false,
    context: observation.context,
    originSample: observation.originSample,
    endSample: observation.endSample,
    micGapMs: observation.micGapMs,
    backingGapMs: observation.backingGapMs,
    strictPassed: observation.strictPassed,
    reason: observation.shadow?.reason ?? null,
    wouldPass: observation.strictPassed || observation.shadow?.wouldPass === true,
    failureStage: observation.shadow?.failureStage ?? null,
    error: observation.error ?? observation.shadow?.error ?? null,
    micLevelDbfs: effective?.micLevelDbfs ?? observation.shadow?.micLevelDbfs ?? null,
    backingLevelDbfs: effective?.backingLevelDbfs ?? observation.shadow?.backingLevelDbfs ?? null,
    micLagMs: effective?.micLagMs ?? null,
    confidence: effective?.confidence ?? null,
    bestLagMs: diagnostics?.bestLagMs ?? null,
    bestScore: diagnostics?.bestScore ?? null,
    runnerUpLagMs: diagnostics?.runnerUpLagMs ?? null,
    runnerUpScore: diagnostics?.runnerUpScore ?? null,
    peakMargin: diagnostics?.peakMargin ?? null,
    activeBands: diagnostics?.activeBands ?? [],
    supportingBands: diagnostics?.supportingBands ?? [],
    segmentLagsMs: effective?.segmentLagsMs ?? [],
    segmentCorrelations: effective?.segmentCorrelations ?? [],
  };
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
  private readonly passiveShadowEnabled: boolean;
  private readonly onPassiveShadow: NonNullable<CalibrationSessionOptions['onPassiveShadow']>;
  private readonly passiveShadowCollector: TimingWindowCollector;

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

  /**
   * Passive shadow uses the full calibration identity fence. Destructive source
   * changes must invalidate partial evidence; a mapped follower correction may
   * span a window only when the source layer intentionally preserves sourceGeneration.
   */
  private passiveShadowMeasuredContext: CalibrationPassiveShadowContext | null = null;
  private passiveShadowAnalysisPending = false;
  private passiveShadowAnalysisAbortController: AbortController | null = null;
  private passiveShadowAnalysisRevision = 0;

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
    this.passiveShadowEnabled = options.passiveShadowEnabled
      ?? process.env.RELAY_CALIBRATION_SHADOW_LOW_LEVEL === '1';
    this.onPassiveShadow = options.onPassiveShadow ?? ((observation) => {
      console.log(`[calibration-shadow] ${JSON.stringify(passiveShadowLogPayload(observation))}`);
    });

    // Preserve the old bounded-buffer rule exactly: enough slack for every
    // agreement window plus one window of start skew.
    this.collector = new TimingWindowCollector(
      this.requiredSamples,
      this.requiredSamples * (this.agreementWindows + 1),
    );
    this.passiveShadowCollector = new TimingWindowCollector(
      this.requiredSamples,
      this.requiredSamples * 2,
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
    this.invalidatePassiveShadowAnalysis();
    this.passiveShadowCollector.reset();
    this.passiveShadowMeasuredContext = null;
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

  /** Read-only, context-fenced PCM for media-transition verification only. */
  transitionEvidence(maxSamples: number): TimingWindow | null {
    const currentContext = this.context();
    const ownsPrimedEvidence = this.primedContext !== null
      && this.contextsEqual(this.primedContext, currentContext);
    if ((!this.collecting && !ownsPrimedEvidence) || this.analysisPending) return null;
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
   * authority while the external candidate is being measured. Passive content
   * observation also remains independent so probe retries cannot starve it.
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
    this.invalidatePassiveShadowAnalysis();
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
    this.passiveShadowCollector.reset();
    this.passiveShadowMeasuredContext = null;
  }

  /** `startSample` is where `AudioSession` placed these samples on its timeline. */
  observeMic(samples: Int16Array, startSample: number) {
    this.observePassiveShadow('mic', samples, startSample);
    if (!this.collecting || samples.length === 0) return;
    this.collector.observeMic(samples, startSample);
    this.drainReadyWindows();
  }

  observeBacking(samples: Int16Array, startSample: number) {
    this.observePassiveShadow('backing', samples, startSample);
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

  private invalidatePassiveShadowAnalysis() {
    this.passiveShadowAnalysisAbortController?.abort();
    this.passiveShadowAnalysisAbortController = null;
    this.passiveShadowAnalysisRevision += 1;
    this.passiveShadowAnalysisPending = false;
  }

  private observePassiveShadow(
    side: 'mic' | 'backing',
    samples: Int16Array,
    startSample: number,
  ) {
    if (
      !this.passiveShadowEnabled
      || this.collecting
      || this.passiveShadowAnalysisPending
      || samples.length === 0
    ) return;

    const currentContext = passiveShadowContext(this.context());
    if (currentContext === null) {
      this.passiveShadowCollector.reset();
      this.passiveShadowMeasuredContext = null;
      return;
    }

    if (!samePassiveShadowContext(this.passiveShadowMeasuredContext, currentContext)) {
      this.passiveShadowCollector.reset();
      this.passiveShadowMeasuredContext = currentContext;
    }

    if (side === 'mic') this.passiveShadowCollector.observeMic(samples, startSample);
    else this.passiveShadowCollector.observeBacking(samples, startSample);
    this.finishReadyPassiveShadowWindow();
  }

  private finishReadyPassiveShadowWindow() {
    const window = this.passiveShadowCollector.takeReadyWindow();
    const measuredContext = this.passiveShadowMeasuredContext;
    if (window === null || measuredContext === null) return;

    const micGapMs = Math.round((window.micGapSamples / this.sampleRate) * 1000);
    const backingGapMs = Math.round((window.backingGapSamples / this.sampleRate) * 1000);
    if (Math.max(micGapMs, backingGapMs) > MAX_CAPTURE_GAP_MS) {
      this.emitPassiveShadow({
        authoritative: false,
        context: { ...measuredContext },
        originSample: window.originSample,
        endSample: window.endSample,
        micGapMs,
        backingGapMs,
        strictPassed: false,
        error: `Passive shadow window lost ${Math.max(micGapMs, backingGapMs)} ms of audio.`,
        result: null,
        shadow: null,
      });
      this.passiveShadowCollector.reset();
      return;
    }

    let capturedShadow: TimingCalibrationShadowAnalysis | null = null;
    const abortController = new AbortController();
    this.passiveShadowAnalysisAbortController = abortController;

    try {
      const result = this.analyze(
        window.mic,
        window.backing,
        this.sampleRate,
        this.maxLagMs,
        abortController.signal,
        (shadow) => {
          capturedShadow = shadow;
        },
        true,
      );

      if (isPromiseLikeAnalysis(result)) {
        const revision = ++this.passiveShadowAnalysisRevision;
        this.passiveShadowAnalysisPending = true;
        void Promise.resolve(result).then(
          (analysis) => this.settlePassiveShadowAnalysis(
            revision,
            measuredContext,
            window,
            micGapMs,
            backingGapMs,
            analysis,
            capturedShadow,
          ),
          (error: unknown) => this.rejectPassiveShadowAnalysis(
            revision,
            measuredContext,
            window,
            micGapMs,
            backingGapMs,
            error,
            capturedShadow,
          ),
        );
        return;
      }

      this.passiveShadowAnalysisAbortController = null;
      this.completePassiveShadowWindow(measuredContext, window, micGapMs, backingGapMs, {
        strictPassed: true,
        error: null,
        result,
        shadow: capturedShadow,
      });
    } catch (error) {
      this.passiveShadowAnalysisAbortController = null;
      this.completePassiveShadowWindow(measuredContext, window, micGapMs, backingGapMs, {
        strictPassed: false,
        error: error instanceof Error ? error.message : String(error),
        result: null,
        shadow: capturedShadow,
      });
    }
  }

  private settlePassiveShadowAnalysis(
    revision: number,
    measuredContext: CalibrationPassiveShadowContext,
    window: TimingWindow,
    micGapMs: number,
    backingGapMs: number,
    result: TimingCalibrationAnalysis,
    shadow: TimingCalibrationShadowAnalysis | null,
  ) {
    if (revision !== this.passiveShadowAnalysisRevision || !this.passiveShadowAnalysisPending) return;
    this.passiveShadowAnalysisPending = false;
    this.passiveShadowAnalysisAbortController = null;
    this.completePassiveShadowWindow(measuredContext, window, micGapMs, backingGapMs, {
      strictPassed: true,
      error: null,
      result,
      shadow,
    });
  }

  private rejectPassiveShadowAnalysis(
    revision: number,
    measuredContext: CalibrationPassiveShadowContext,
    window: TimingWindow,
    micGapMs: number,
    backingGapMs: number,
    error: unknown,
    shadow: TimingCalibrationShadowAnalysis | null,
  ) {
    if (revision !== this.passiveShadowAnalysisRevision || !this.passiveShadowAnalysisPending) return;
    this.passiveShadowAnalysisPending = false;
    this.passiveShadowAnalysisAbortController = null;
    this.completePassiveShadowWindow(measuredContext, window, micGapMs, backingGapMs, {
      strictPassed: false,
      error: error instanceof Error ? error.message : String(error),
      result: null,
      shadow,
    });
  }

  private completePassiveShadowWindow(
    measuredContext: CalibrationPassiveShadowContext,
    window: TimingWindow,
    micGapMs: number,
    backingGapMs: number,
    outcome: Pick<
      CalibrationPassiveShadowObservation,
      'strictPassed' | 'error' | 'result' | 'shadow'
    >,
  ) {
    const currentContext = passiveShadowContext(this.context());
    if (!samePassiveShadowContext(measuredContext, currentContext)) {
      this.passiveShadowCollector.reset();
      this.passiveShadowMeasuredContext = currentContext;
      return;
    }

    this.emitPassiveShadow({
      authoritative: false,
      context: { ...measuredContext },
      originSample: window.originSample,
      endSample: window.endSample,
      micGapMs,
      backingGapMs,
      ...outcome,
    });
    // Samples arriving while the worker was busy were intentionally ignored.
    // Start the next evidence window at a fresh shared session position.
    this.passiveShadowCollector.reset();
    this.passiveShadowMeasuredContext = currentContext;
  }

  private emitPassiveShadow(observation: CalibrationPassiveShadowObservation) {
    this.onPassiveShadow(observation);
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
