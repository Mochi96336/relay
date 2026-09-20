/**
 * Keep Chrome tab capture on the same realtime budget as the Phone and
 * WebSocket fallback. Once PCM is already older than this it must become a
 * positioned hole, not delayed Song audio.
 */
export const TAB_CAPTURE_DISPATCH_BACKLOG_MS = 200;

export function classifyTabCaptureDispatch({
  currentContextTimeSeconds,
  capturedAtContextTimeSeconds,
  backlogMs = TAB_CAPTURE_DISPATCH_BACKLOG_MS,
} = {}) {
  if (!Number.isFinite(backlogMs) || backlogMs <= 0) {
    throw new RangeError('backlogMs must be positive');
  }

  const now = typeof currentContextTimeSeconds === 'number'
    ? currentContextTimeSeconds
    : Number.NaN;
  const capturedAt = typeof capturedAtContextTimeSeconds === 'number'
    ? capturedAtContextTimeSeconds
    : Number.NaN;

  if (!Number.isFinite(now) || !Number.isFinite(capturedAt) || now < 0 || capturedAt < 0) {
    return { measurable: false, lagMs: null, stale: false };
  }

  const lagMs = Math.max(0, (now - capturedAt) * 1000);
  return {
    measurable: true,
    lagMs,
    stale: lagMs > backlogMs,
  };
}
