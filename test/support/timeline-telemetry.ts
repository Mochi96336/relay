const VIDEO = 'dQw4w9WgXcQ';

/** A playback tab's YouTube telemetry, as the Song timeline tests send it. */
export function telemetry(overrides: Record<string, unknown> = {}) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.5,
    ...overrides,
  };
}
