export const VIDEO = 'dQw4w9WgXcQ';

/**
 * A playback tab's YouTube player report: the room video, playing at 10 s,
 * well buffered. A test passes only what its report says differently;
 * `fields` replace any of it.
 */
export function youtubeTelemetry<T extends Record<string, unknown>>(fields: T = {} as T) {
  return {
    videoId: VIDEO,
    state: 1,
    currentTime: 10,
    duration: 200,
    playbackRate: 1,
    bufferedFraction: 0.8,
    ...fields,
  };
}
