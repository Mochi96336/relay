export type BootProbeRunIdentityInput = {
  sessionCurrent: boolean;
  captureGenerationMatches: boolean;
};

export type BootProbeRunIdentityDecision =
  | { kind: 'current' }
  | { kind: 'abandon'; reason: 'session' | 'capture-generation' };

/**
 * One identity fence shared by every Boot Probe lifecycle stage.
 *
 * Session/run identity is authoritative before capture generation. This
 * pure policy owns only that precedence; callers keep lazy sampling and
 * all lifecycle/reporting effects so a stale session never forces an
 * unnecessary capture-generation read.
 */
export function decideBootProbeRunIdentity(
  input: BootProbeRunIdentityInput,
): BootProbeRunIdentityDecision {
  if (!input.sessionCurrent) {
    return { kind: 'abandon', reason: 'session' };
  }
  if (!input.captureGenerationMatches) {
    return { kind: 'abandon', reason: 'capture-generation' };
  }
  return { kind: 'current' };
}
