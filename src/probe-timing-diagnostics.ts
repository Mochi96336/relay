/** Whitelist bounded durations and clock evidence; absolute client clocks never align audio. */
export function sanitizeProbeTimingDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const result: Record<string, number | null> = {};
  for (const key of ['processingMs', 'schedulingDelayMs', 'acknowledgedAtMs', 'contextSeconds',
    'scheduledContextSeconds', 'baseLatencyMs', 'outputLatencyMs',
    'outputContextSeconds', 'outputPerformanceMs']) {
    const n = source[key];
    result[key] = typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12 ? n : null;
  }
  return result;
}

/** Separate local preparation from transport. Only durations share clock units
 * across hosts; this still assumes symmetric network transit, never synchronized clocks. */
export function probeScheduleTime(sentAtMs: number, receivedAtMs: number, leadMs: number,
  client: Record<string, number | null> | null) {
  const roundTripMs = receivedAtMs - sentAtMs;
  const processing = client?.processingMs;
  const scheduling = client?.schedulingDelayMs;
  if (typeof processing !== 'number' || typeof scheduling !== 'number'
    || !Number.isFinite(processing) || !Number.isFinite(scheduling)
    || processing < 0 || processing > roundTripMs || scheduling < 0 || scheduling > processing) {
    return { targetAtMs: sentAtMs + roundTripMs / 2 + leadMs,
      method: 'legacy-rtt-half', transportOneWayMs: roundTripMs / 2, schedulingDelayMs: null };
  }
  const transportOneWayMs = (roundTripMs - processing) / 2;
  return { targetAtMs: sentAtMs + transportOneWayMs + scheduling + leadMs,
    method: 'processing-separated', transportOneWayMs, schedulingDelayMs: scheduling };
}
