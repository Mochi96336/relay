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

/** A page clock offset is used only if it could be true of this exchange, give or take this much. */
const PAGE_CLOCK_CAUSALITY_SLACK_MS = 5;

/**
 * When the probe was scheduled to play, on the server's clock.
 *
 * Local preparation is separated from transport, and only durations share
 * clock units across hosts. Without a known page clock the request and the
 * reply are assumed to have travelled equally long: one reply held up for
 * 160 ms places the probe 80 ms late, and on 2026-10-31 two probes of one
 * capture 47 s apart, both above 0.92 correlation, read 140 and 60 ms.
 *
 * `pageClockOffsetMs` is the server's clock minus the page's, as the room
 * clock measures it from that page's playback reports over the last minute.
 * With it the page's own time for the probe is used and neither leg's travel
 * time matters. It also makes the probe and the Robot's offset rest on one
 * estimate of the page's clock, so what that estimate is off by cancels in
 * `mic - backing + delta`. It is used only when it is consistent with this
 * exchange: the page cannot have received the request before it was sent, or
 * acknowledged it after the reply arrived. Another tab's clock fails that.
 */
export function probeScheduleTime(sentAtMs: number, receivedAtMs: number, leadMs: number,
  client: Record<string, number | null> | null, pageClockOffsetMs: number | null = null) {
  const roundTripMs = receivedAtMs - sentAtMs;
  const processing = client?.processingMs;
  const scheduling = client?.schedulingDelayMs;
  if (typeof processing !== 'number' || typeof scheduling !== 'number'
    || !Number.isFinite(processing) || !Number.isFinite(scheduling)
    || processing < 0 || processing > roundTripMs || scheduling < 0 || scheduling > processing) {
    return { targetAtMs: sentAtMs + roundTripMs / 2 + leadMs,
      method: 'legacy-rtt-half', transportOneWayMs: roundTripMs / 2, schedulingDelayMs: null };
  }
  const acknowledgedAt = client?.acknowledgedAtMs;
  if (pageClockOffsetMs !== null && Number.isFinite(pageClockOffsetMs)
    && typeof acknowledgedAt === 'number' && Number.isFinite(acknowledgedAt)) {
    const pageReceivedAtMs = acknowledgedAt - processing + pageClockOffsetMs;
    const pageAcknowledgedAtMs = acknowledgedAt + pageClockOffsetMs;
    if (pageReceivedAtMs >= sentAtMs - PAGE_CLOCK_CAUSALITY_SLACK_MS
      && pageAcknowledgedAtMs <= receivedAtMs + PAGE_CLOCK_CAUSALITY_SLACK_MS) {
      return { targetAtMs: pageReceivedAtMs + scheduling + leadMs,
        method: 'page-clock', transportOneWayMs: Math.max(0, pageReceivedAtMs - sentAtMs), schedulingDelayMs: scheduling };
    }
  }
  const transportOneWayMs = (roundTripMs - processing) / 2;
  return { targetAtMs: sentAtMs + transportOneWayMs + scheduling + leadMs,
    method: 'processing-separated', transportOneWayMs, schedulingDelayMs: scheduling };
}
