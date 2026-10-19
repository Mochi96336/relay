const VIDEO = 'dQw4w9WgXcQ';

/** A playback tab's YouTube telemetry, as the Song handoff tests send it. */
export function telemetry(currentTime: number, overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...overrides,
  };
}
