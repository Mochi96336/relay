import { performance } from 'node:perf_hooks';

import type { CalibrationContext } from './calibration-session.js';
import { analyzeTimingCalibration, type TimingCalibrationAnalysis } from './timing-calibration.js';
import { TimingWindowCollector } from './timing-window-collector.js';

export type ContentValidationState = 'inactive' | 'waiting' | 'collecting' | 'suspect';
export type ContentValidationOutcome =
  | 'stable'
  | 'suspect'
  | 'drift-confirmed'
  | 'inconclusive'
  | 'invalid';

export type ConfirmedContentCalibration = {
  micLagMs: number;
  confidence: number | null;
  segmentLagsMs: number[];
  context: CalibrationContext;
};

export type ContentValidationStatus = {
  enabled: boolean;
  state: ContentValidationState;
  baselineLagMs: number | null;
  lastMeasuredLagMs: number | null;
  lastDeltaMs: number | null;
  suspectLagMs: number | null;
  lastOutcome: ContentValidationOutcome | null;
  lastValidationAgeMs: number | null;
  nextValidationInMs: number | null;
};

export type ContentCalibrationValidatorOptions = {
  sampleRate: number;
  durationMs: number;
  timeoutMs: number;
  intervalMs: number;
  retryMs: number;
  deviationThresholdMs: number;
  agreementToleranceMs: number;
  context: () => CalibrationContext;
  enabled?: boolean;
  maxGapMs?: number;
  maxLagMs?: number;
  now?: () => number;
  analyze?: (
    mic: Int16Array,
    backing: Int16Array,
    sampleRate: number,
    maxLagMs?: number,
    signal?: AbortSignal,
  ) => TimingCalibrationAnalysis | PromiseLike<TimingCalibrationAnalysis>;
  /** Fired after every externally visible validator state/status transition. */
  onChange?: () => void;
  onDriftConfirmed?: (
    result: TimingCalibrationAnalysis,
    context: CalibrationContext,
  ) => void;
};

type Candidate = {
  result: TimingCalibrationAnalysis;
  deltaMs: number;
};

const DEFAULT_MAX_GAP_MS = 300;

function sameContext(a: CalibrationContext, b: CalibrationContext) {
  return a.sessionGeneration === b.sessionGeneration
    && a.micGeneration === b.micGeneration
    && a.backingGeneration === b.backingGeneration
    && a.sourceGeneration === b.sourceGeneration;
}

function finitePositive(name: string, value: number) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
}

function isPromiseLikeAnalysis(
  value: TimingCalibrationAnalysis | PromiseLike<TimingCalibrationAnalysis>,
): value is PromiseLike<TimingCalibrationAnalysis> {
  return 'then' in value && typeof value.then === 'function';
}

/**
 * Periodically re-measures a confirmed content-calibration baseline.
 *
 * The validator is deliberately conservative: one deviating window only creates
 * a suspect. A second, non-overlapping window must deviate in the same direction
 * and land within the normal calibration agreement tolerance before the newest
 * measurement is promoted. Weak/ambiguous analysis, transport holes, timeout,
 * or an interrupted confirmation never mutate the baseline.
 *
 * It owns no WebSocket, YouTube, recording, or robot policy. The server decides
 * when the content path is eligible to call `maybeStart`, and may call `cancel`
 * whenever runtime readiness is withdrawn.
 */
export class ContentCalibrationValidator {
  readonly durationMs: number;
  readonly requiredSamples: number;

  private readonly sampleRate: number;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;
  private readonly retryMs: number;
  private readonly deviationThresholdMs: number;
  private readonly agreementToleranceMs: number;
  private readonly context: () => CalibrationContext;
  private readonly enabled: boolean;
  private readonly maxGapSamples: number;
  private readonly maxLagMs: number | undefined;
  private readonly now: () => number;
  private readonly analyze: NonNullable<ContentCalibrationValidatorOptions['analyze']>;
  private readonly onChange: NonNullable<ContentCalibrationValidatorOptions['onChange']>;
  private readonly onDriftConfirmed: NonNullable<ContentCalibrationValidatorOptions['onDriftConfirmed']>;
  private readonly collector: TimingWindowCollector;

  private state: ContentValidationState = 'inactive';
  private baseline: ConfirmedContentCalibration | null = null;
  private suspect: Candidate | null = null;
  private startedAt = 0;
  private nextValidationAt = Number.POSITIVE_INFINITY;
  private lastValidationAt = Number.NEGATIVE_INFINITY;
  private lastMeasuredLagMs: number | null = null;
  private lastDeltaMs: number | null = null;
  private lastOutcome: ContentValidationOutcome | null = null;
  private analysisPending = false;
  private analysisAbortController: AbortController | null = null;
  private analysisRevision = 0;

  constructor(options: ContentCalibrationValidatorOptions) {
    finitePositive('sampleRate', options.sampleRate);
    finitePositive('durationMs', options.durationMs);
    finitePositive('timeoutMs', options.timeoutMs);
    finitePositive('intervalMs', options.intervalMs);
    finitePositive('retryMs', options.retryMs);
    finitePositive('deviationThresholdMs', options.deviationThresholdMs);
    finitePositive('agreementToleranceMs', options.agreementToleranceMs);

    this.sampleRate = options.sampleRate;
    this.durationMs = options.durationMs;
    this.timeoutMs = options.timeoutMs;
    this.intervalMs = options.intervalMs;
    this.retryMs = options.retryMs;
    this.deviationThresholdMs = options.deviationThresholdMs;
    this.agreementToleranceMs = options.agreementToleranceMs;
    this.context = options.context;
    this.enabled = options.enabled ?? true;
    this.maxGapSamples = Math.round(
      (options.sampleRate * (options.maxGapMs ?? DEFAULT_MAX_GAP_MS)) / 1_000,
    );
    this.maxLagMs = options.maxLagMs;
    this.now = options.now ?? (() => performance.now());
    this.analyze = options.analyze ?? analyzeTimingCalibration;
    this.onChange = options.onChange ?? (() => {});
    this.onDriftConfirmed = options.onDriftConfirmed ?? (() => {});
    this.requiredSamples = Math.round((options.sampleRate * options.durationMs) / 1_000);
    this.collector = new TimingWindowCollector(this.requiredSamples, this.requiredSamples * 2);
  }

  get collecting() {
    return this.state === 'collecting';
  }

  get hasBaseline() {
    return this.baseline !== null;
  }

  setBaseline(baseline: ConfirmedContentCalibration, nowMs = this.now()) {
    this.invalidatePendingAnalysis();
    this.baseline = {
      ...baseline,
      segmentLagsMs: [...baseline.segmentLagsMs],
      context: { ...baseline.context },
    };
    this.suspect = null;
    this.collector.reset();
    this.lastMeasuredLagMs = null;
    this.lastDeltaMs = null;
    this.lastOutcome = null;
    this.lastValidationAt = Number.NEGATIVE_INFINITY;
    this.nextValidationAt = nowMs + this.intervalMs;
    this.state = this.enabled ? 'waiting' : 'inactive';
    this.onChange();
  }

  clearBaseline() {
    this.invalidatePendingAnalysis();
    this.baseline = null;
    this.suspect = null;
    this.collector.reset();
    this.state = 'inactive';
    this.nextValidationAt = Number.POSITIVE_INFINITY;
    this.lastMeasuredLagMs = null;
    this.lastDeltaMs = null;
    this.lastOutcome = null;
    this.lastValidationAt = Number.NEGATIVE_INFINITY;
    this.onChange();
  }

  /**
   * Drops an in-flight validation without invalidating the confirmed baseline.
   * Any suspect is also discarded so confirmation always consists of two
   * consecutive valid windows with no readiness interruption between them.
   */
  cancel(nowMs = this.now()) {
    if (this.baseline === null) {
      this.clearBaseline();
      return;
    }
    this.invalidatePendingAnalysis();
    this.collector.reset();
    this.suspect = null;
    this.state = this.enabled ? 'waiting' : 'inactive';
    this.nextValidationAt = nowMs + this.retryMs;
    this.onChange();
  }

  /** Starts one validation window when its schedule is due. */
  maybeStart(nowMs = this.now()) {
    if (!this.enabled || this.baseline === null || this.state === 'collecting') return false;
    if (!sameContext(this.baseline.context, this.context())) {
      this.clearBaseline();
      return false;
    }
    if (nowMs < this.nextValidationAt) return false;

    this.collector.reset();
    this.startedAt = nowMs;
    this.state = 'collecting';
    this.onChange();
    return true;
  }

  observeMic(samples: Int16Array, startSample: number) {
    if (!this.collecting || this.analysisPending) return;
    this.collector.observeMic(samples, startSample);
    this.finishReadyWindow();
  }

  observeBacking(samples: Int16Array, startSample: number) {
    if (!this.collecting || this.analysisPending) return;
    this.collector.observeBacking(samples, startSample);
    this.finishReadyWindow();
  }

  /** Invalidates a stalled observation but leaves the known-good baseline active. */
  tick(nowMs = this.now()) {
    if (!this.collecting || this.analysisPending || nowMs - this.startedAt <= this.timeoutMs) {
      return false;
    }
    this.finishInvalid(nowMs);
    return true;
  }

  status(nowMs = this.now()): ContentValidationStatus {
    return {
      enabled: this.enabled,
      state: this.state,
      baselineLagMs: this.baseline?.micLagMs ?? null,
      lastMeasuredLagMs: this.lastMeasuredLagMs,
      lastDeltaMs: this.lastDeltaMs,
      suspectLagMs: this.suspect?.result.micLagMs ?? null,
      lastOutcome: this.lastOutcome,
      lastValidationAgeMs: Number.isFinite(this.lastValidationAt)
        ? Math.max(0, Math.round(nowMs - this.lastValidationAt))
        : null,
      nextValidationInMs: this.state === 'waiting' || this.state === 'suspect'
        ? Math.max(0, Math.round(this.nextValidationAt - nowMs))
        : null,
    };
  }

  private finishReadyWindow() {
    const window = this.collector.takeReadyWindow();
    if (!window || this.baseline === null) return;

    // The window belongs to the baseline context that existed when it started.
    // A capture restart or seek must never be promoted as runtime drift.
    const currentContext = this.context();
    if (!sameContext(this.baseline.context, currentContext)) {
      this.clearBaseline();
      return;
    }

    if (
      window.micGapSamples > this.maxGapSamples
      || window.backingGapSamples > this.maxGapSamples
    ) {
      this.finishInvalid(this.now());
      return;
    }

    try {
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
          (analysis) => this.settlePendingAnalysis(revision, currentContext, analysis),
          () => this.rejectPendingAnalysis(revision),
        );
        return;
      }

      this.analysisAbortController = null;
      this.applyAnalysis(result, currentContext, this.now());
    } catch {
      this.analysisAbortController = null;
      this.finishInvalid(this.now());
    }
  }

  private invalidatePendingAnalysis() {
    this.analysisAbortController?.abort();
    this.analysisAbortController = null;
    this.analysisRevision += 1;
    this.analysisPending = false;
  }

  private settlePendingAnalysis(
    revision: number,
    context: CalibrationContext,
    result: TimingCalibrationAnalysis,
  ) {
    if (revision !== this.analysisRevision || !this.analysisPending) return;
    this.analysisPending = false;
    this.analysisAbortController = null;
    this.applyAnalysis(result, context, this.now());
  }

  private rejectPendingAnalysis(revision: number) {
    if (revision !== this.analysisRevision || !this.analysisPending) return;
    this.analysisPending = false;
    this.analysisAbortController = null;
    this.finishInvalid(this.now());
  }

  private applyAnalysis(
    result: TimingCalibrationAnalysis,
    measuredContext: CalibrationContext,
    nowMs: number,
  ) {
    if (
      this.baseline === null
      || !sameContext(this.baseline.context, measuredContext)
      || !sameContext(measuredContext, this.context())
    ) {
      this.clearBaseline();
      return;
    }

    const deltaMs = result.micLagMs - this.baseline.micLagMs;
    this.lastMeasuredLagMs = result.micLagMs;
    this.lastDeltaMs = deltaMs;
    this.lastValidationAt = nowMs;

    if (Math.abs(deltaMs) <= this.deviationThresholdMs) {
      this.suspect = null;
      this.lastOutcome = 'stable';
      this.state = 'waiting';
      this.nextValidationAt = nowMs + this.intervalMs;
      this.onChange();
      return;
    }

    if (this.suspect === null) {
      this.suspect = { result, deltaMs };
      this.lastOutcome = 'suspect';
      this.state = 'suspect';
      // Confirmation is a fresh, non-overlapping six-second window as soon as
      // the server says the content path is ready again.
      this.nextValidationAt = nowMs;
      this.onChange();
      return;
    }

    const sameDirection = Math.sign(deltaMs) === Math.sign(this.suspect.deltaMs);
    const candidatesAgree = Math.abs(result.micLagMs - this.suspect.result.micLagMs)
      <= this.agreementToleranceMs;

    if (sameDirection && candidatesAgree) {
      this.suspect = null;
      this.lastOutcome = 'drift-confirmed';
      const promotedContext = { ...measuredContext };
      this.baseline = {
        micLagMs: result.micLagMs,
        confidence: result.confidence,
        segmentLagsMs: [...result.segmentLagsMs],
        context: promotedContext,
      };
      this.state = 'waiting';
      this.nextValidationAt = nowMs + this.intervalMs;
      // Promotion may synchronously publish calibration/source status; set all
      // validator truth first so that publication already carries the new state.
      this.onDriftConfirmed(result, promotedContext);
      this.onChange();
      return;
    }

    // Two independent windows disagreed, so neither earns authority. Do not
    // chain the second one forward as a new suspect: confirmation must start
    // from a clean pair rather than accumulate a moving sequence of guesses.
    this.suspect = null;
    this.lastOutcome = 'inconclusive';
    this.state = 'waiting';
    this.nextValidationAt = nowMs + this.intervalMs;
    this.onChange();
  }

  private finishInvalid(nowMs: number) {
    this.collector.reset();
    this.suspect = null;
    this.lastOutcome = 'invalid';
    this.lastValidationAt = nowMs;
    this.state = this.baseline !== null && this.enabled ? 'waiting' : 'inactive';
    this.nextValidationAt = this.state === 'waiting'
      ? nowMs + this.retryMs
      : Number.POSITIVE_INFINITY;
    this.onChange();
  }
}
