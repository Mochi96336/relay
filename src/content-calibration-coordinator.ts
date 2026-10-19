import { CalibrationSession, type CalibrationSessionOptions } from './calibration-session.js';
import { ContentCalibrationValidator, type ContentCalibrationValidatorOptions } from './content-calibration-validator.js';
import {
  autoContentCalibrationAuthorityAllowsStart,
  autoContentCalibrationLivePathReady,
  autoContentCalibrationPrerequisitesReady,
  autoContentCalibrationStartMode,
} from './auto-content-calibration-policy.js';
import { decideContentValidationBaselineSync } from './content-validation-baseline-policy.js';
import {
  contentValidationAuthorityReady,
  contentValidationLivePathReady,
  contentValidationPathPrerequisitesReady,
} from './content-validation-path-policy.js';
import type { TimingRuntime, TimingCalibrationKind } from './timing-runtime.js';

export type ContentCalibrationConfig = {
  automatic: boolean;
  measurement: Omit<CalibrationSessionOptions, 'onSettled'>;
  validation: Omit<ContentCalibrationValidatorOptions, 'context' | 'onChange' | 'onDriftConfirmed'>;
};

export type ContentCalibrationHost = {
  timing: Pick<TimingRuntime,
    'autoCalibrationDue' | 'beginContentCalibration' | 'syncConfirmedAuthority'
    | 'markContentAuthority' | 'prepareContentValidationSlew'
    | 'markContentValidationBaseline' | 'clearContentValidationBaseline'
    | 'contentValidationBaselineRevision'>;
  authority: {
    kind(): TimingCalibrationKind;
    stale(): boolean;
    apply(): void;
  };
  route: {
    robotActive(): boolean;
    bootSettled(nowMs: number): boolean;
    bootExhausted(nowMs: number): boolean;
    evidenceMappingReady(nowMs: number): boolean;
  };
  media: {
    active(): boolean;
    backingConnected(): boolean;
    micControlConnected(): boolean;
    streamsFlowing(nowMs: number): boolean;
    timeline(nowMs?: number): { connected?: boolean; state?: number | null };
    noteMicMeasured(): void;
  };
  takeBlocked(): boolean;
  timingChanged(): void;
  sourceChanged(): void;
};

/**
 * Coordinates content measurement and independent drift validation. The two
 * domain objects own their PCM windows and analysis lifetimes; this owner
 * controls admission, replacement and the order in which authority becomes
 * visible to the mixer and observers.
 */
export class ContentCalibrationCoordinator {
  readonly measurement: CalibrationSession;
  readonly validation: ContentCalibrationValidator;
  /** Last confirmation already considered for a new acoustic Mic measurement. */
  private measuredRevision = 0;

  constructor(
    private readonly config: ContentCalibrationConfig,
    private readonly host: ContentCalibrationHost,
  ) {
    this.measurement = new CalibrationSession({
      ...config.measurement,
      onSettled: () => this.settled(),
    });
    this.validation = new ContentCalibrationValidator({
      ...config.validation,
      context: config.measurement.context,
      onChange: () => host.timingChanged(),
      onDriftConfirmed: (result) => {
        host.timing.markContentAuthority();
        // Promotion calls settled synchronously: install the slew revision
        // before the mixer observes the new authority.
        host.timing.prepareContentValidationSlew(this.measurement.confirmedRevision + 1);
        this.measurement.applyValidatedResult(result);
        // Keep the validator's drift-confirmed diagnostics rather than reseed.
        host.timing.markContentValidationBaseline(this.measurement.confirmedRevision);
      },
    });
  }

  clearValidationBaseline() {
    this.host.timing.clearContentValidationBaseline();
    this.validation.clearBaseline();
  }

  cancelValidation(nowMs: number) {
    const state = this.validation.status(nowMs).state;
    if (!this.validation.collecting && state !== 'suspect') return false;
    this.validation.cancel(nowMs);
    return true;
  }

  /** The recording command calls this only after the Take commits. */
  standDownForTake(nowMs: number) {
    // Both owners publish their own transition. Do not emit the same status
    // again after their synchronous callbacks have already committed it.
    this.cancelValidation(nowMs);
    this.measurement.abandon();
  }

  startManual(nowMs: number) {
    this.cancelValidation(nowMs);
    this.host.timing.beginContentCalibration(nowMs, false);
    this.measurement.start(nowMs);
    this.host.timingChanged();
  }

  /** Automatic replacement precedes validation admission in the same tick. */
  tick(nowMs: number) {
    this.maybeStartAutomatic(nowMs);
    this.syncValidationBaseline(nowMs);
    if (!this.validation.hasBaseline) return;
    if (!this.validationPathReady(nowMs)) {
      this.cancelValidation(nowMs);
      return;
    }
    this.validation.tick(nowMs);
    this.validation.maybeStart(nowMs);
  }

  private settled() {
    const { measurement, host } = this;
    host.timing.syncConfirmedAuthority({
      confirmedRevision: measurement.confirmedRevision,
      hasConfirmedResult: measurement.confirmedResult !== null,
    });
    // Reapplication of boot evidence is not a new acoustic Mic measurement.
    if (measurement.confirmedRevision !== this.measuredRevision) {
      this.measuredRevision = measurement.confirmedRevision;
      if (host.authority.kind() !== 'boot-probe') host.media.noteMicMeasured();
    }
    host.authority.apply();
    host.timingChanged();
    host.sourceChanged();
  }

  private syncValidationBaseline(nowMs: number) {
    const { measurement, validation, host } = this;
    const confirmed = measurement.confirmedResult;
    const decision = decideContentValidationBaselineSync({
      appliedKind: host.authority.kind(),
      hasConfirmedResult: confirmed !== null,
      calibrationStale: confirmed !== null && host.authority.stale(),
      hasBaseline: validation.hasBaseline,
      baselineRevision: host.timing.contentValidationBaselineRevision,
      confirmedRevision: measurement.confirmedRevision,
    });
    if (decision === 'none') return;
    if (decision === 'clear') {
      this.clearValidationBaseline();
      return;
    }
    if (confirmed === null) return;
    validation.setBaseline({
      micLagMs: confirmed.micLagMs,
      confidence: confirmed.confidence,
      segmentLagsMs: confirmed.segmentLagsMs,
      context: this.config.measurement.context(),
    }, nowMs);
    host.timing.markContentValidationBaseline(measurement.confirmedRevision);
  }

  private maybeStartAutomatic(nowMs: number) {
    const { measurement, host } = this;
    if (!this.config.automatic || host.takeBlocked()) return;
    const robotRoute = host.route.robotActive();
    if (!autoContentCalibrationPrerequisitesReady({
      bootProbeSettled: host.route.bootSettled(nowMs),
      robotRouteActive: robotRoute,
      robotEvidenceMappingReady: !robotRoute || host.route.evidenceMappingReady(nowMs),
      sessionActive: host.media.active(),
      calibrationCollecting: measurement.collecting,
    })) return;
    const freshConfirmedResult = measurement.confirmedResult !== null && !host.authority.stale();
    const appliedKind = freshConfirmedResult && robotRoute ? host.authority.kind() : null;
    if (!autoContentCalibrationAuthorityAllowsStart({
      freshConfirmedResult, robotRouteActive: robotRoute, appliedKind,
    })) return;

    // A retry not yet due must not sample physical transport or timeline state.
    const retryDue = host.timing.autoCalibrationDue(nowMs);
    const backingConnected = retryDue && host.media.backingConnected();
    const micControlConnected = backingConnected && host.media.micControlConnected();
    const streamsFlowing = micControlConnected && host.media.streamsFlowing(nowMs);
    const timeline = streamsFlowing ? host.media.timeline() : null;
    if (!autoContentCalibrationLivePathReady({
      retryDue, backingConnected, micControlConnected, streamsFlowing,
      timelineConnected: Boolean(timeline?.connected),
      timelinePlaying: Number(timeline?.state) === 1,
    })) return;
    host.timing.beginContentCalibration(nowMs, true);
    if (autoContentCalibrationStartMode(host.route.bootExhausted(nowMs)) === 'primed') {
      measurement.startFromPrimed(nowMs);
    } else {
      measurement.start(nowMs);
    }
    host.timingChanged();
  }

  private validationPathReady(nowMs: number) {
    const { measurement, host } = this;
    const robotRoute = host.route.robotActive();
    if (!contentValidationPathPrerequisitesReady({
      enabled: this.config.validation.enabled ?? true,
      takeBlocked: host.takeBlocked(),
      bootProbeSettled: host.route.bootSettled(nowMs),
      robotRouteActive: robotRoute,
      robotEvidenceMappingReady: !robotRoute || host.route.evidenceMappingReady(nowMs),
      sessionActive: host.media.active(),
      calibrationCollecting: measurement.collecting,
    })) return false;
    const confirmed = measurement.confirmedResult;
    const appliedKind = host.authority.kind();
    if (!contentValidationAuthorityReady({
      appliedKind,
      hasConfirmedResult: confirmed !== null,
      calibrationStale: appliedKind === 'content' && confirmed !== null && host.authority.stale(),
    })) return false;
    const timeline = host.media.timeline(nowMs);
    return contentValidationLivePathReady({
      backingConnected: host.media.backingConnected(),
      micControlConnected: host.media.micControlConnected(),
      streamsFlowing: host.media.streamsFlowing(nowMs),
      timelineConnected: Boolean(timeline.connected),
      timelinePlaying: Number(timeline.state) === 1,
    });
  }
}
