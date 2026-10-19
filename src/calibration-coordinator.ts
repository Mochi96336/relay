import type { BootProbeCoordinator } from './boot-probe-coordinator.js';
import type { ContentCalibrationCoordinator } from './content-calibration-coordinator.js';
import type { TimingRuntime } from './timing-runtime.js';

export type CalibrationCoordinatorHost = {
  content: Pick<ContentCalibrationCoordinator, 'measurement' | 'clearValidationBaseline' | 'cancelValidation' | 'tick'>;
  probe: Pick<BootProbeCoordinator, 'expireRequest' | 'finishAnalysis' | 'startIfReady' | 'restart' | 'clear' | 'abandon'>;
  timing: Pick<TimingRuntime, 'calibrationKind' | 'clearCalibrationKind' | 'resetAutoCalibrationSchedule'>;
  route: {
    robotActive(): boolean;
    bootSettled(nowMs: number): boolean;
    sweepContentTransition(nowMs: number): void;
  };
  alignment: {
    apply(): boolean;
    reapplyBoot(nowMs: number): void;
  };
  silentSides(beforeMs: number): string[];
  timingChanged(): void;
  sourceChanged(): void;
};

/**
 * Orders the room's timing strategies. Probe expiry, route retirement and
 * alignment withdrawal must settle before fresh evidence can be promoted;
 * mapping transitions must settle before content admission reads them.
 * Transport callbacks may retire a legacy route immediately through the same
 * transaction used by the periodic scheduler.
 */
export class CalibrationCoordinator {
  constructor(
    private readonly collectionSilenceGraceMs: number,
    private readonly host: CalibrationCoordinatorHost,
  ) {}

  startManualBoot(nowMs: number) {
    const { content, alignment, probe } = this.host;
    content.clearValidationBaseline();
    content.measurement.beginExternalRecalibration();
    // Apply retained authority under its own strategy before the replacement
    // probe changes the candidate kind.
    alignment.apply();
    probe.restart(nowMs);
    this.host.sourceChanged();
  }

  /** Owner/route authority ended. Reset strategy and retry metadata as well. */
  invalidateTiming(reason: string) {
    const { probe, content, timing, alignment } = this.host;
    probe.clear();
    content.clearValidationBaseline();
    if (content.measurement.collecting) content.measurement.fail(reason);
    else content.measurement.reset();
    timing.clearCalibrationKind();
    timing.resetAutoCalibrationSchedule();
    alignment.apply();
    this.host.timingChanged();
    this.host.sourceChanged();
  }

  /** New publisher capture: retire acoustic evidence, retain confirmed history. */
  micCaptureReplaced() {
    this.host.probe.clear();
    this.captureInvalidated('Microphone reconnected during calibration. Start calibration again.');
  }

  /** PCM declared a new capture generation on the existing physical route. */
  captureRestarted(side: 'mic' | 'backing') {
    this.host.probe.abandon();
    const source = side === 'mic' ? 'Microphone' : 'Backing';
    this.captureInvalidated(`${source} capture restarted during calibration. Start calibration again.`);
  }

  /** The physical mapper must advance its Source context before calling this. */
  mappingRevoked(reason: string) {
    const { content, alignment } = this.host;
    // An idle primed backup belongs to the old frame. Collecting evidence is
    // retired by fail below, including any pending asynchronous analysis.
    content.measurement.discardPrimedContent();
    content.clearValidationBaseline();
    if (content.measurement.collecting) content.measurement.fail(reason);
    // Pipeline boot evidence is independent of content coordinates and survives.
    alignment.apply();
    this.host.sourceChanged();
    this.host.timingChanged();
  }

  /** SourceRuntime and the mapper have already committed the physical change. */
  robotSourceActivated(replaced: boolean, nowMs: number) {
    if (replaced) this.retireSourceReference();
    this.retireLegacyForRobot(nowMs);
    this.host.alignment.apply();
    this.host.sourceChanged();
    this.host.timingChanged();
  }

  robotSourceDisconnected() {
    this.retireSourceReference();
    this.host.alignment.apply();
    this.host.sourceChanged();
    this.host.timingChanged();
  }

  /** A media interruption stops content work without erasing confirmed history. */
  interruptContent(reason: string, nowMs: number) {
    const { content } = this.host;
    if (content.measurement.collecting) content.measurement.fail(reason);
    // The validator publishes its own cancellation transition.
    content.cancelValidation(nowMs);
  }

  /** Called after AudioSession has stopped; observers publish the whole stop. */
  reset() {
    const { probe, content, timing } = this.host;
    probe.clear();
    content.clearValidationBaseline();
    content.measurement.reset();
    timing.clearCalibrationKind();
    timing.resetAutoCalibrationSchedule();
  }

  private retireSourceReference() {
    const { probe, content } = this.host;
    probe.abandon();
    content.measurement.discardPrimedContent();
    content.clearValidationBaseline();
    if (content.measurement.collecting) {
      content.measurement.fail('The Robot source changed during calibration. Start calibration again.');
    }
  }

  private captureInvalidated(reason: string) {
    const { content, alignment } = this.host;
    content.clearValidationBaseline();
    if (content.measurement.collecting) {
      // Settlement publishes the failure once. Cancel immediately even when
      // backing is absent: reconnect liveness must not own analysis lifetime.
      content.measurement.fail(reason);
      return;
    }
    alignment.apply();
    // Publish the stale timing before observers see the new source generation.
    this.host.timingChanged();
    this.host.sourceChanged();
  }

  retireLegacyForRobot(nowMs: number) {
    const { route, timing, content, alignment } = this.host;
    if (!route.robotActive() || timing.calibrationKind !== 'content') return;
    // Content belonging to this Robot route is a valid boot upgrade. Only a
    // measurement inherited from the earlier route needs to be retired.
    if (route.bootSettled(nowMs)) return;
    content.clearValidationBaseline();
    content.measurement.reset();
    timing.clearCalibrationKind();
    timing.resetAutoCalibrationSchedule();
    alignment.apply();
  }

  tick(nowMs: number) {
    const { content, probe, alignment, route } = this.host;
    const measurement = content.measurement;
    if (measurement.collecting) {
      const silent = this.host.silentSides(nowMs - this.collectionSilenceGraceMs);
      if (silent.length > 0) {
        measurement.fail(
          `Calibration stopped: no audio from the ${silent.join(' or ')}. `
          + 'Restart the backing source: on a development desktop the source page was probably reloaded, which drops the tab capture.',
        );
      } else if (!measurement.tick(nowMs)) {
        this.host.timingChanged();
      }
    }

    probe.expireRequest(nowMs);
    this.retireLegacyForRobot(nowMs);
    if (alignment.apply()) {
      this.host.sourceChanged();
      this.host.timingChanged();
    }
    probe.finishAnalysis(nowMs);
    probe.startIfReady(nowMs);
    alignment.reapplyBoot(nowMs);
    route.sweepContentTransition(nowMs);
    content.tick(nowMs);
  }
}
