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

/** One monitor's positioned-PCM delivery: what was sent and what it confirmed. */
export type MonitorDelivery = {
  sent: { generation: number; endSampleIndex: number } | null;
  acknowledged: { generation: number; endSampleIndex: number } | null;
};

/**
 * Mix samples sent to a monitor that it has not confirmed receiving, or null
 * for a monitor that never confirms anything (an older Listen page).
 *
 * The socket's own backlog is blind to everything past this process: behind a
 * tunnel or reverse proxy the server writes to a local connection that always
 * drains, and seconds of stale PCM queue up downstream where bufferedAmount
 * never sees them. Only the listener can say what actually arrived. An
 * acknowledgement from an earlier mix generation confirms nothing of the
 * current one, whose sample positions start again from zero.
 */
export function monitorUnacknowledgedSamples(delivery: MonitorDelivery) {
  const { sent, acknowledged } = delivery;
  if (!acknowledged) return null;
  if (!sent) return 0;
  const confirmed = acknowledged.generation === sent.generation ? acknowledged.endSampleIndex : 0;
  return Math.max(0, sent.endSampleIndex - confirmed);
}
