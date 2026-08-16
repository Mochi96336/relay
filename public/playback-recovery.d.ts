export type PlaybackLeaderHealth = 'unknown' | 'missing' | 'disconnected' | 'stale' | 'healthy';
export type PlaybackRecoveryStatusLike = Record<string, unknown> | null;

export function playbackLeaderHealth(
  timeline: PlaybackRecoveryStatusLike,
): PlaybackLeaderHealth;

export function canRecoverPlayback(input: {
  role: unknown;
  timeline: PlaybackRecoveryStatusLike;
}): boolean;

export function shouldForceMuteListen(input: {
  role: unknown;
  timeline: PlaybackRecoveryStatusLike;
}): boolean;
