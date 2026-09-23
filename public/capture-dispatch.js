import { DEFAULT_WEBSOCKET_BACKLOG_MS } from './audio-transport.js';

/**
 * Keep the pre-transport capture queue on the same realtime budget as the
 * WebSocket fallback. Audio that is already older than this is no longer useful
 * as live voice and must become a timeline hole rather than delayed playback.
 */
export const DEFAULT_CAPTURE_DISPATCH_BACKLOG_MS = DEFAULT_WEBSOCKET_BACKLOG_MS;

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
