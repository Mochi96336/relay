export type CalibrationMixerApplicability = 'apply' | 'hold' | 'revoke';
export type CalibrationMixerKind = 'none' | 'content' | 'boot-probe';

export type CalibrationMixerApplicationInput = {
  applicability: CalibrationMixerApplicability;
  calibrationKind: CalibrationMixerKind;
  activeMicLagMs: number | null;
  nextMicLagMs: number | null;
  robotContentAuthority: boolean;
  hasContentValidationSlew: boolean;
  contentValidationSlewMatchesRevision: boolean;
  calibratedMicLagTarget: number | null;
  jitterThresholdMs: number;
};

export type CalibrationMixerApplicationDecision =
  | { kind: 'none'; clearContentValidationSlew: boolean }
  | { kind: 'set'; micLagMs: number | null; clearContentValidationSlew: true }
  | { kind: 'slew'; micLagMs: number; clearContentValidationSlew: true };

/**
 * Decides how non-Boot calibration authority should affect the live mixer.
 *
 * The server remains responsible for deriving the live lag from runtime state,
 * and TimingRuntime/AudioSession remain the owners of the effects. This pure
 * policy only preserves the precedence that prevents Robot offset noise from
 * splicing the read head and lets drift-confirmed validation corrections slew
 * instead of jump.
 */
export function decideCalibrationMixerApplication(
  input: CalibrationMixerApplicationInput,
): CalibrationMixerApplicationDecision {
  if (input.applicability === 'hold') {
    return { kind: 'none', clearContentValidationSlew: false };
  }

  // Any prepared validation slew, even one that no longer matches the current
  // confirmed revision, bypasses the normal Robot jitter hold. A mismatched
  // revision is cleaned up by the later set path rather than being mistaken for
  // an ordinary player-offset wobble.
  if (
    input.robotContentAuthority
    && !input.hasContentValidationSlew
    && input.activeMicLagMs !== null
    && input.nextMicLagMs !== null
    && Math.abs(input.nextMicLagMs - input.activeMicLagMs) < input.jitterThresholdMs
  ) {
    return { kind: 'none', clearContentValidationSlew: false };
  }

  if (input.activeMicLagMs === input.nextMicLagMs) {
    return {
      kind: 'none',
      clearContentValidationSlew: input.contentValidationSlewMatchesRevision,
    };
  }

  if (
    input.calibrationKind === 'content'
    && input.activeMicLagMs !== null
    && input.nextMicLagMs !== null
    && input.contentValidationSlewMatchesRevision
  ) {
    return {
      kind: 'slew',
      micLagMs: input.nextMicLagMs,
      clearContentValidationSlew: true,
    };
  }

  // The periodic synchronizer may run again while AudioSession is still moving
  // toward a validation target. Reissuing the same target is unnecessary, and
  // snapping with setAlignment would defeat the slew entirely.
  if (
    input.nextMicLagMs !== null
    && input.calibratedMicLagTarget === input.nextMicLagMs
  ) {
    return { kind: 'none', clearContentValidationSlew: false };
  }

  return {
    kind: 'set',
    micLagMs: input.nextMicLagMs,
    clearContentValidationSlew: true,
  };
}
