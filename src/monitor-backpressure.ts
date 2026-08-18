const PCM16_BYTES_PER_SAMPLE = Int16Array.BYTES_PER_ELEMENT;

/**
 * Convert a realtime mono PCM backlog budget into the WebSocket bytes that may
 * wait server-side. This is deliberately a time budget: a large byte constant
 * silently turns into seconds of stale audio when the media rate changes.
 */
export function monitorBacklogBudgetBytes(sampleRate: number, backlogMs: number) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('Monitor backlog sample rate must be positive.');
  }
  if (!Number.isFinite(backlogMs) || backlogMs <= 0) {
    throw new Error('Monitor backlog duration must be positive.');
  }
  return Math.max(1, Math.round(
    (sampleRate * PCM16_BYTES_PER_SAMPLE * backlogMs) / 1_000,
  ));
}

/**
 * Realtime monitor audio prefers a gap over replaying old PCM. Reject the next
 * frame before enqueueing it if doing so would exceed the server-side budget.
 */
export function monitorFrameWouldExceedBacklog(
  bufferedAmount: number,
  nextFrameBytes: number,
  budgetBytes: number,
) {
  const queued = Number.isFinite(bufferedAmount) ? Math.max(0, bufferedAmount) : 0;
  const incoming = Number.isFinite(nextFrameBytes) ? Math.max(0, nextFrameBytes) : 0;
  return queued + incoming > budgetBytes;
}
