export type TimingCalibrationKind = 'none' | 'content' | 'boot-probe';

export type TimingRuntimeOptions = {
  autoCalibrationRetryMs: number;
};

/**
 * Owns timing/calibration orchestration metadata, not measurement authority.
 *
 * `CalibrationSession` still owns collection, analysis, promotion and confirmed
 * results. `ContentCalibrationValidator` still owns drift validation. Robot
 * mapping/probe evidence stays with the Robot/probe owners. This runtime only
 * centralizes the cross-transaction state the server previously kept as loose
 * globals while deciding when and how those owners should run.
 */
export class TimingRuntime {
  private readonly autoCalibrationRetryMs: number;
  private calibrationKindValue: TimingCalibrationKind = 'none';
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

  get calibrationKind() {
    return this.calibrationKindValue;
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

  /** Marks content as the active authority without changing how the run began. */
  markContentAuthority() {
    this.calibrationKindValue = 'content';
  }

  beginBootProbe(automatic: boolean) {
    this.calibrationKindValue = 'boot-probe';
    this.automaticValue = automatic;
  }

  /** Marks boot-probe authority without rewriting manual/automatic provenance. */
  markBootProbeAuthority() {
    this.calibrationKindValue = 'boot-probe';
  }

  clearCalibrationKind() {
    this.calibrationKindValue = 'none';
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
}
