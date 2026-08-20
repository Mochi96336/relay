export function shouldRequestAudioResume(state) {
  return state === 'suspended' || state === 'interrupted';
}

function defaultNow() {
  return Date.now();
}

/**
 * Keeps AudioContext resume evidence separate from realtime timeline staleness.
 *
 * A short OS interruption can recover on the existing monitor connection when
 * no audio was dropped. If the page stayed suspended long enough to risk a
 * queued backlog, or an accepted monitor frame arrived while playback was not
 * rendering, recovery must rejoin the current live edge instead.
 */
export function createAudioInterruptionTracker({ staleAfterMs = 250, now = defaultNow } = {}) {
  const configuredStaleAfterMs = Number(staleAfterMs);
  const staleThresholdMs = Number.isFinite(configuredStaleAfterMs)
    ? Math.max(0, configuredStaleAfterMs)
    : 250;
  let startedAt = null;
  let droppedPlayback = false;

  function readNow() {
    const value = Number(now());
    return Number.isFinite(value) ? value : defaultNow();
  }

  function begin() {
    if (startedAt === null) startedAt = readNow();
  }

  function noteDroppedPlayback() {
    begin();
    droppedPlayback = true;
  }

  function finish() {
    if (startedAt === null) {
      droppedPlayback = false;
      return { interrupted: false, durationMs: 0, requiresLiveEdge: false };
    }

    const durationMs = Math.max(0, readNow() - startedAt);
    const requiresLiveEdge = droppedPlayback || durationMs >= staleThresholdMs;
    startedAt = null;
    droppedPlayback = false;
    return { interrupted: true, durationMs, requiresLiveEdge };
  }

  function reset() {
    startedAt = null;
    droppedPlayback = false;
  }

  return {
    begin,
    noteDroppedPlayback,
    finish,
    reset,
  };
}
