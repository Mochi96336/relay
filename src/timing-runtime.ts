export type TimingCalibrationKind = 'none' | 'content' | 'boot-probe';

export type TimingRuntimeOptions = {
  autoCalibrationRetryMs: number;
};

export type AppliedCalibrationKindFacts = {
  confirmedRevision: number;
  hasConfirmedResult: boolean;
  provisional: boolean;
};

/**
 * Owns timing/calibration orchestration metadata, not measurement authority.
 *
 * `CalibrationSession` still owns collection, analysis, promotion and confirmed
 * results. `ContentCalibrationValidator` still owns drift validation. Robot
 * mapping/probe evidence stays with the Robot/probe owners. This runtime only
 * centralizes the cross-transaction state the server previously kept as loose
 * globals while deciding when and how those owners should run.
 *
 * Candidate strategy and confirmed authority are deliberately separate. A
 * manual retry may switch from content to boot-probe while the old confirmed
 * content result remains applied. The retry kind must not reclassify that old
 * result before a new confirmation revision is actually promoted.
 */
export class TimingRuntime {
  private readonly autoCalibrationRetryMs: number;
  /** Strategy currently collecting/probing, or the last strategy when idle. */
  private calibrationKindValue: TimingCalibrationKind = 'none';
  /** Strategy that produced the currently confirmed calibration revision. */
  private authorityKindValue: TimingCalibrationKind = 'none';
  private authorityRevisionValue = 0;
  private automaticValue = false;
  private lastAutoCalibrationAt = Number.NEGATIVE_INFINITY;
  private contentValidationBaselineRevisionValue = -1;
  private contentValidationSlewRevisionValue: number | null = null;

  constructor(options: TimingRuntimeOptions) {
    if (!Number.isFinite(options.autoCalibrationRetryMs) || options.autoCalibrationRetryMs <= 0) {
      throw new Error('autoCalibrationRetryMs must be a positive finite number.');
    }
    this.autoCalibrationRetryMs = options.autoCalibrationRetryMs;
  }

  /** Candidate/orchestration kind. Do not use this to reinterpret retained authority. */
  get calibrationKind() {
    return this.calibrationKindValue;
  }

  /** Kind that produced the current confirmed authority revision. */
  get authorityKind() {
    return this.authorityKindValue;
  }

  get authorityRevision() {
    return this.authorityRevisionValue;
  }

  get automatic() {
    return this.automaticValue;
  }

  get contentValidationBaselineRevision() {
    return this.contentValidationBaselineRevisionValue;
  }

  get contentValidationSlewRevision() {
    return this.contentValidationSlewRevisionValue;
  }

  autoCalibrationDue(nowMs: number) {
    return nowMs - this.lastAutoCalibrationAt >= this.autoCalibrationRetryMs;
  }

  beginContentCalibration(nowMs: number, automatic: boolean) {
    this.calibrationKindValue = 'content';
    this.automaticValue = automatic;
    if (automatic) this.lastAutoCalibrationAt = nowMs;
  }

  /** Marks content as the strategy about to synchronously promote a result. */
  markContentAuthority() {
    this.calibrationKindValue = 'content';
  }

  beginBootProbe(automatic: boolean) {
    this.calibrationKindValue = 'boot-probe';
    this.automaticValue = automatic;
  }

  /** Marks boot-probe as the strategy about to synchronously promote a result. */
  markBootProbeAuthority() {
    this.calibrationKindValue = 'boot-probe';
  }

  /**
   * Returns the strategy that owns the value currently exposed by
   * `CalibrationSession.result`.
   *
   * A provisional value belongs to the in-flight candidate. A non-provisional
   * value belongs to the last confirmed revision, whose kind changes only when
   * that monotonic revision changes. Merely beginning a different retry cannot
   * mutate confirmed provenance.
   */
  appliedCalibrationKind(facts: AppliedCalibrationKindFacts): TimingCalibrationKind {
    this.syncConfirmedAuthority(facts.confirmedRevision, facts.hasConfirmedResult);
    if (facts.provisional) return this.calibrationKindValue;
    return facts.hasConfirmedResult ? this.authorityKindValue : 'none';
  }

  /** Restore orchestration after a failed replacement candidate kept old authority. */
  restoreCandidateKindToAuthority() {
    this.calibrationKindValue = this.authorityKindValue;
  }

  clearCalibrationKind() {
    this.calibrationKindValue = 'none';
    this.authorityKindValue = 'none';
  }

  resetAutoCalibrationSchedule() {
    this.lastAutoCalibrationAt = Number.NEGATIVE_INFINITY;
  }

  markContentValidationBaseline(revision: number) {
    this.contentValidationBaselineRevisionValue = revision;
  }

  prepareContentValidationSlew(nextConfirmedRevision: number) {
    this.contentValidationSlewRevisionValue = nextConfirmedRevision;
  }

  contentValidationSlewMatches(confirmedRevision: number) {
    return this.contentValidationSlewRevisionValue === confirmedRevision;
  }

  clearContentValidationSlew() {
    this.contentValidationSlewRevisionValue = null;
  }

  clearContentValidationBaseline() {
    this.contentValidationBaselineRevisionValue = -1;
    this.contentValidationSlewRevisionValue = null;
  }

  private syncConfirmedAuthority(confirmedRevision: number, hasConfirmedResult: boolean) {
    if (!Number.isSafeInteger(confirmedRevision) || confirmedRevision < 0) {
      throw new Error('confirmedRevision must be a non-negative safe integer.');
    }

    if (!hasConfirmedResult) {
      this.authorityKindValue = 'none';
      this.authorityRevisionValue = confirmedRevision;
      return;
    }

    if (confirmedRevision === this.authorityRevisionValue) return;
    this.authorityRevisionValue = confirmedRevision;
    this.authorityKindValue = this.calibrationKindValue;
  }
}
