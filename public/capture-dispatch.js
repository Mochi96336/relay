/**
 * How old worklet PCM may be when the main thread finally dispatches it.
 *
 * Every packet carries its capture position and Relay places it there, so a
 * late chunk is never played late: it either lands before the mix read head
 * reaches its position, or it is simply never read. Relay's live mix reads
 * the Mic about its default 400 ms prebuffer behind real time, so a chunk
 * delayed by a main-thread stall shorter than that is usually still playable.
 * Dropping it here at the network backlog budget instead turned every
 * 200-400 ms stall into a hole the mix could have filled. Older than this, the
 * chunk cannot be heard and only costs uplink, so it stays a timeline hole.
 * Network congestion keeps its own, tighter, WebSocket backlog bound.
 */
export const DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS = 400;

export function classifyCaptureDispatch({
  currentContextTimeSeconds,
  capturedAtContextTimeSeconds,
  fallbackCapturedAtContextTimeSeconds,
  backlogMs = DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS,
} = {}) {
  if (!Number.isFinite(backlogMs) || backlogMs <= 0) {
    throw new RangeError('backlogMs must be positive');
  }

  const now = typeof currentContextTimeSeconds === 'number'
    ? currentContextTimeSeconds
    : Number.NaN;
  const explicitCapturedAt = typeof capturedAtContextTimeSeconds === 'number'
    ? capturedAtContextTimeSeconds
    : Number.NaN;
  const fallbackCapturedAt = typeof fallbackCapturedAtContextTimeSeconds === 'number'
    ? fallbackCapturedAtContextTimeSeconds
    : Number.NaN;
  // New worklets timestamp the oldest sample precisely. The fallback exists
  // only for rollout-compatible raw PCM from an older cached worklet: its
  // positioned sample clock is still enough to bound main-thread backlog.
  const capturedAt = Number.isFinite(explicitCapturedAt)
    ? explicitCapturedAt
    : fallbackCapturedAt;
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
