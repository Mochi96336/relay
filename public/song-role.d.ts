export type PlaybackSurfaceRole = 'empty' | 'holder' | 'preparing' | 'observer';

export type PlaybackStatusLike = Record<string, unknown> | null;

export function resolvePlaybackRole(input: {
  timeline: PlaybackStatusLike;
  room: PlaybackStatusLike;
  participantId: string;
  transportId: string;
  playbackGeneration: number;
}): PlaybackSurfaceRole | null;
