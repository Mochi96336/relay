export type BootProbeAnalysisReadinessInput = {
  sessionCurrent: boolean;
  captureGenerationMatches: boolean;
  nowMs: number;
  deadlineMs: number;
  reachedSamples: number;
  neededSamples: number;
};

export type BootProbeAnalysisReadinessDecision =
  | { kind: 'abandon'; reason: 'session' | 'capture-generation' }
  | { kind: 'timeout' }
  | { kind: 'wait' }
  | { kind: 'ready' };

/**
 * Decides whether a pending Boot Probe analysis may consume its window.
 *
 * This policy deliberately owns no lifecycle mutation. The server still
 * abandons stale runs, consumes timed-out/ready analyses, records failures,
 * and performs DSP. The ordering here is the safety property: stale run
 * identity beats timeout, timeout beats sample readiness, and the deadline
 * remains strict (`nowMs > deadlineMs`) rather than inclusive.
 */
export function decideBootProbeAnalysisReadiness(
  input: BootProbeAnalysisReadinessInput,
): BootProbeAnalysisReadinessDecision {
  if (!input.sessionCurrent) {
    return { kind: 'abandon', reason: 'session' };
  }
  if (!input.captureGenerationMatches) {
    return { kind: 'abandon', reason: 'capture-generation' };
  }
  if (input.nowMs > input.deadlineMs) return { kind: 'timeout' };
  if (input.reachedSamples < input.neededSamples) return { kind: 'wait' };
  return { kind: 'ready' };
}
