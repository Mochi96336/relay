/**
 * Research-only Mic repair deadline estimate.
 *
 * Relay ALREADY has a production 60 ms mix-headroom gate controlling whether
 * an original or repeated packet may hold the ordered stream. This helper
 * does not replace that gate, schedule retransmission, or control production.
 *
 * Crucially, MicRuntime's current mixHeadroomMs is a global frontier measure,
 * NOT a per-sequence deadline. A future enforce-mode experiment must first
 * obtain each missing packet's authoritative sample position. Until then this
 * estimate is observational only: it can identify promising test cases but
 * MUST NOT be used to suppress live retransmission requests.
 */
export type RepairRoundTripTiming = {
  rttMs: number;
  variationMs: number;
  observations: number;
};

export type RepairDeadlineEstimate = {
  classification: 'unknown' | 'below-existing-hold-gate' | 'probably-late' | 'plausibly-on-time';
  availableMs: number | null;
  predictedMs: number | null;
};

export type RepairDeadlineInput = {
  mixHeadroomMs: number | null;
  timing: RepairRoundTripTiming | null;
  /** Match the existing MicRuntime hold gate; not an additional hold policy. */
  existingGuardMs?: number;
  /** Analysis-only scheduling margin for request dispatch/processing. */
  dispatchMarginMs?: number;
  /** A confidence guard over smoothed first-repair RTT variability. */
  variationFactor?: number;
  /** A single successful repair is too little evidence for enforcement. */
  minObservations?: number;
};

export function estimateRepairDeadline({
  mixHeadroomMs,
  timing,
  existingGuardMs = 60,
  dispatchMarginMs = 10,
  variationFactor = 2,
  minObservations = 3,
}: RepairDeadlineInput): RepairDeadlineEstimate {
  if (mixHeadroomMs === null || !Number.isFinite(mixHeadroomMs)) {
    return { classification: 'unknown', availableMs: null, predictedMs: null };
  }
  const availableMs = Math.max(0, mixHeadroomMs - existingGuardMs);
  if (mixHeadroomMs <= existingGuardMs) {
    return { classification: 'below-existing-hold-gate', availableMs, predictedMs: null };
  }
  if (
    !timing
    || timing.observations < minObservations
    || !Number.isFinite(timing.rttMs)
    || !Number.isFinite(timing.variationMs)
    || timing.rttMs < 0
    || timing.variationMs < 0
  ) {
    // Cold start and path changes must not accidentally disable exploration.
    return { classification: 'unknown', availableMs, predictedMs: null };
  }
  const predictedMs = timing.rttMs + variationFactor * timing.variationMs + dispatchMarginMs;
  return {
    classification: predictedMs < availableMs ? 'plausibly-on-time' : 'probably-late',
    availableMs,
    predictedMs,
  };
}
