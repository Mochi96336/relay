const PCM16_BYTES_PER_SAMPLE = Int16Array.BYTES_PER_ELEMENT;

/**
 * Convert a mono PCM latency budget into queued WebSocket bytes.
 *
 * Realtime media prefers a timeline hole over replaying seconds-old PCM after
 * a weak link recovers. `minimumFrameBytes` keeps a deliberately large frame
 * sendable instead of creating a configuration that drops every frame forever.
 */
export function realtimePcmBacklogBudgetBytes(
  sampleRate: number,
  backlogMs: number,
  minimumFrameBytes = 0,
) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('Realtime uplink sample rate must be positive.');
  }
  if (!Number.isFinite(backlogMs) || backlogMs <= 0) {
    throw new Error('Realtime uplink backlog duration must be positive.');
  }
  if (!Number.isFinite(minimumFrameBytes) || minimumFrameBytes < 0) {
    throw new Error('Realtime uplink minimum frame bytes must be non-negative.');
  }

  const timedBudget = Math.max(1, Math.round(
    (sampleRate * PCM16_BYTES_PER_SAMPLE * backlogMs) / 1_000,
  ));
  return Math.max(timedBudget, Math.ceil(minimumFrameBytes));
}

/** Reject before enqueueing the frame that would push stale PCM past budget. */
export function realtimeFrameWouldExceedBacklog(
  bufferedAmount: number,
  nextFrameBytes: number,
  budgetBytes: number,
) {
  const queued = Number.isFinite(bufferedAmount) ? Math.max(0, bufferedAmount) : 0;
  const incoming = Number.isFinite(nextFrameBytes) ? Math.max(0, nextFrameBytes) : 0;
  const budget = Number.isFinite(budgetBytes) ? Math.max(0, budgetBytes) : 0;
  return queued + incoming > budget;
}
