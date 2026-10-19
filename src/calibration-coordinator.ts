import type { BootProbeCoordinator } from './boot-probe-coordinator.js';
import type { ContentCalibrationCoordinator } from './content-calibration-coordinator.js';
import type { TimingRuntime } from './timing-runtime.js';

export type CalibrationCoordinatorHost = {
  content: Pick<ContentCalibrationCoordinator, 'measurement' | 'clearValidationBaseline' | 'tick'>;
  probe: Pick<BootProbeCoordinator, 'expireRequest' | 'finishAnalysis' | 'startIfReady' | 'restart'>;
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
