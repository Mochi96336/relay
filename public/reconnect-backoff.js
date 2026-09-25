// How long the publisher waits before reconnecting its control socket.
//
// On a WebSocket-only page the Mic audio rides that socket, so every
// millisecond spent waiting to reconnect is Mic audio that never reaches the
// room. Most drops are a single blip (a Wi-Fi roam, a NAT rebinding, Relay
// closing a stalled socket so TCP can start over), and the first retry should
// go out almost at once: Relay can repair what was captured meanwhile only
// while its live hold lasts, a few hundred milliseconds. A retry that fails
// backs off, and the schedule starts over only after a connection has
// actually stayed up, so a server that keeps refusing is not hammered.

export const DEFAULT_RECONNECT_DELAYS_MS = Object.freeze([100, 400, 1000]);
export const DEFAULT_RECONNECT_STABLE_AFTER_MS = 5000;

export function createReconnectBackoff({
  delaysMs = DEFAULT_RECONNECT_DELAYS_MS,
  stableAfterMs = DEFAULT_RECONNECT_STABLE_AFTER_MS,
} = {}) {
  if (!Array.isArray(delaysMs) || delaysMs.length < 1) {
    throw new RangeError('delaysMs must be a non-empty array');
  }
  for (const delay of delaysMs) {
    if (!Number.isFinite(delay) || delay < 0) throw new RangeError('delaysMs must be non-negative');
  }
  if (!Number.isFinite(stableAfterMs) || stableAfterMs < 0) {
    throw new RangeError('stableAfterMs must be non-negative');
  }
  const delays = [...delaysMs];
  let attempt = 0;
  let connectedAtMs = null;

  return {
    /** The wait before the next reconnect attempt; each call is one attempt. */
    nextDelayMs() {
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      return delay;
    },
    /** A socket opened. */
    noteConnected(nowMs) {
      connectedAtMs = nowMs;
    },
    /** The open socket closed; a connection that lasted starts the schedule over. */
    noteClosed(nowMs) {
      if (connectedAtMs !== null && nowMs - connectedAtMs >= stableAfterMs) attempt = 0;
      connectedAtMs = null;
    },
    /** Start over, for a new capture. */
    reset() {
      attempt = 0;
      connectedAtMs = null;
    },
  };
}
