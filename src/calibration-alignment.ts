import { performance } from 'node:perf_hooks';

import type { AudioSession } from './audio-session.js';
import type { BootProbeCoordinator } from './boot-probe-coordinator.js';
import type { BootProbeContext } from './boot-probe-runtime.js';
import { decideBootProbeMixerApplication } from './boot-probe-mixer-application.js';
import { decideBootProbeReapplication, type BootProbeReapplicationReason } from './boot-probe-reapplication.js';
import { decideCalibrationApplicability } from './calibration-applicability.js';
import { decideCalibrationMixerApplication } from './calibration-mixer-application.js';
import type { CalibrationContext, CalibrationSession } from './calibration-session.js';
import { mediaToWallMs } from './boot-calibration.js';
import type { TimingCalibrationKind, TimingRuntime } from './timing-runtime.js';

export type AppliedCalibrationAuthority = Readonly<{ revision: number; kind: TimingCalibrationKind }>;

export type CalibrationAlignmentHost = {
  measurement: Pick<CalibrationSession,
    'status' | 'result' | 'confirmedResult' | 'confirmedRevision' | 'transactionActive' | 'collecting' | 'isStaleFor'>;
  audio: Pick<AudioSession, 'alignment' | 'calibratedMicLagTarget' | 'setAlignment' | 'slewCalibratedMicLagTo'>;
  timing: Pick<TimingRuntime,
    'appliedCalibrationKind' | 'contentValidationSlewRevision' | 'contentValidationSlewMatches' | 'clearContentValidationSlew'>;
  probe: Pick<BootProbeCoordinator, 'pathDifferenceMs' | 'calibrationResult' | 'completedContextMatches' | 'reapply'>;
  context(): CalibrationContext;
  probeContext(): BootProbeContext;
  route: {
    robotActive(): boolean;
    probeTimingActive(): boolean;
    bootSettled(nowMs: number): boolean;
    sourceConnected(): boolean;
  };
  mapping: {
    roomHasSong(nowMs: number): boolean;
    deltaFresh(nowMs: number): boolean;
    deltaEverEstablished(): boolean;
    contentReady(nowMs: number): boolean;
    deltaMs(nowMs: number): number;
    playbackRate(nowMs: number): number;
    contentLiveLag(referenceLagMs: number, nowMs: number): number | null;
  };
  takeBlocked(): boolean;
  bootReapplied?(reason: BootProbeReapplicationReason, previousMs: number | null, nextMs: number): void;
};

/**
 * Owns which calibration revision has reached the mixer. Measurement authority
 * remains with CalibrationSession/TimingRuntime; AudioSession owns the read head
 * and slew. This owner keeps their application, hold and revocation semantics
 * together, including the desired alignment observed while a Take freezes it.
 */
export class CalibrationAlignment {
  private appliedAuthority: AppliedCalibrationAuthority | null = null;

  constructor(
    private readonly jitterThresholdMs: number,
    private readonly host: CalibrationAlignmentHost,
    private readonly now = () => performance.now(),
  ) {}

  get authority(): AppliedCalibrationAuthority | null {
    return this.appliedAuthority === null ? null : { ...this.appliedAuthority };
  }

  /** AudioSession has cleared its read head, including during Take finalization. */
  sessionStopped() {
    this.appliedAuthority = null;
  }

  get stale() {
    return this.host.measurement.isStaleFor(this.host.context());
  }

  /** Pure provenance query: a replacement candidate cannot relabel old authority. */
  get kind() {
    const { measurement, timing } = this.host;
    return timing.appliedCalibrationKind({
      hasConfirmedResult: measurement.confirmedResult !== null,
      provisional: measurement.status().provisional,
    });
  }

  /** A quiet live coordinate may hold valid evidence; a changed path revokes it. */
  applicability(kind = this.kind) {
    const { measurement, route, mapping } = this.host;
    const nowMs = this.now();
    const result = measurement.result;
    return decideCalibrationApplicability({
      kind,
      hasResult: result !== null,
      stale: result !== null && this.stale,
      calibrationTransactionActive: measurement.transactionActive,
      calibrationProvisional: measurement.status().provisional,
      hasConfirmedResult: measurement.confirmedResult !== null,
      robotProbeTimingActive: route.probeTimingActive(),
      bootProbeSettled: route.bootSettled(nowMs),
      robotRouteActive: route.robotActive(),
      robotSourceConnected: route.sourceConnected(),
      roomHasSong: mapping.roomHasSong(nowMs),
      robotDeltaFresh: mapping.deltaFresh(nowMs),
      robotDeltaEverEstablished: mapping.deltaEverEstablished(),
      robotContentMappingReady: mapping.contentReady(nowMs),
    });
  }

  /** Pipeline latency is wall time; only the player's media delta follows rate. */
  private bootAdvanceMs(nowMs: number) {
    const pathDifferenceMs = this.host.probe.pathDifferenceMs;
    if (pathDifferenceMs === null) return null;
    return pathDifferenceMs + mediaToWallMs(this.host.mapping.deltaMs(nowMs), this.host.mapping.playbackRate(nowMs));
  }

  /** Observes the mapping without moving a frozen Take's Mic read head. */
  desiredLagMs(nowMs: number): number | null {
    const { measurement, probe, route, mapping } = this.host;
    const kind = this.kind;
    if (route.robotActive() && kind === 'boot-probe') {
      if (measurement.result === null || this.stale) return null;
      if (!probe.completedContextMatches(this.host.probeContext())) return null;
      if (!mapping.roomHasSong(nowMs)) return probe.pathDifferenceMs;
      if (this.applicability(kind) !== 'apply') return null;
      return this.bootAdvanceMs(nowMs);
    }
    if (this.applicability(kind) !== 'apply') return null;
    const result = measurement.result;
    if (result === null) return null;
    if (!route.robotActive() || kind !== 'content') return result.micLagMs;
    return mapping.contentLiveLag(result.micLagMs, nowMs);
  }

  /** Returns whether the mixer's active target changed. Holds keep revisions pending. */
  sync() {
    const { measurement, audio, probe, timing, route, mapping } = this.host;
    if (this.host.takeBlocked()) return false;
    const active = audio.alignment.calibratedMicLagMs;
    const calibrationKind = this.kind;
    const authority = { revision: measurement.confirmedRevision, kind: calibrationKind };
    const newCalibrationAuthority = this.appliedAuthority?.revision !== authority.revision
      || this.appliedAuthority?.kind !== authority.kind;

    if (route.robotActive() && calibrationKind === 'boot-probe') {
      const nowMs = this.now();
      const decision = decideBootProbeMixerApplication({
        activeMicLagMs: active,
        calibratedMicLagTarget: audio.calibratedMicLagTarget,
        roomHasSong: mapping.roomHasSong(nowMs),
        resultMicLagMs: measurement.result?.micLagMs ?? null,
        pathDifferenceMs: probe.pathDifferenceMs,
        calibrationStale: this.stale,
        completedContextMatches: probe.completedContextMatches(this.host.probeContext()),
        applicability: this.applicability(calibrationKind),
        storedDeltaMs: probe.calibrationResult?.deltaMs ?? null,
        currentDeltaMs: mapping.deltaMs(nowMs),
      });
      if (decision.kind === 'hold') return false;
      if (decision.kind === 'retain') {
        this.appliedAuthority = authority;
        return false;
      }
      audio.setAlignment({ calibratedMicLagMs: decision.micLagMs });
      this.appliedAuthority = decision.micLagMs === null ? null : authority;
      return true;
    }
    const applicability = this.applicability(calibrationKind);
    let nextMicLagMs = applicability === 'apply' ? measurement.result!.micLagMs : null;
    const robotContentAuthority = route.robotActive() && calibrationKind === 'content';
    if (nextMicLagMs !== null && robotContentAuthority) {
      nextMicLagMs = mapping.contentLiveLag(nextMicLagMs, this.now());
    }
    const decision = decideCalibrationMixerApplication({
      applicability,
      calibrationKind,
      activeMicLagMs: active,
      nextMicLagMs,
      robotContentAuthority,
      hasContentValidationSlew: timing.contentValidationSlewRevision !== null,
      contentValidationSlewMatchesRevision: timing.contentValidationSlewMatches(measurement.confirmedRevision),
      calibratedMicLagTarget: audio.calibratedMicLagTarget,
      jitterThresholdMs: this.jitterThresholdMs,
      newCalibrationAuthority,
    });
    if (decision.clearContentValidationSlew) timing.clearContentValidationSlew();
    if (applicability === 'apply' && nextMicLagMs !== null) this.appliedAuthority = authority;
    else if (applicability === 'revoke') this.appliedAuthority = null;
    if (decision.kind === 'none') return false;
    if (decision.kind === 'slew') return audio.slewCalibratedMicLagTo(decision.micLagMs);
    audio.setAlignment({ calibratedMicLagMs: decision.micLagMs });
    return true;
  }

  /** Reclaims valid pipeline evidence after content revocation, or follows fresh delta. */
  reapplyBoot(nowMs: number) {
    const { measurement, audio, probe, route, mapping } = this.host;
    if (this.host.takeBlocked() || !route.robotActive()) return;
    const appliedKind = this.kind;
    const applied = audio.alignment.calibratedMicLagMs;
    const decision = decideBootProbeReapplication({
      appliedKind,
      replacementApplicability: appliedKind === 'boot-probe' ? null : this.applicability(appliedKind),
      roomHasSong: mapping.roomHasSong(nowMs),
      pathDifferenceReady: probe.pathDifferenceMs !== null,
      calibrationCollecting: measurement.collecting,
      calibrationTransactionActive: measurement.transactionActive,
      robotDeltaFresh: mapping.deltaFresh(nowMs),
      completedContextMatches: probe.completedContextMatches(this.host.probeContext()),
      advanceMs: this.bootAdvanceMs(nowMs),
      appliedMicLagMs: applied,
      reapplyThresholdMs: this.jitterThresholdMs,
    });
    if (decision.kind === 'none') return;
    this.host.bootReapplied?.(decision.reason, applied, decision.advanceMs);
    probe.reapply(decision.advanceMs, mapping.deltaMs(nowMs));
  }
}
