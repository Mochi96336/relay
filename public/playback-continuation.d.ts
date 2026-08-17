export type ReloadDesiredState = {
  videoId: string;
  positionSeconds: number;
  state: 1 | 2 | 5;
  playbackRate: number;
};

export type PlaybackContinuationDecision = {
  phase: 'continuing' | 'complete' | 'none';
  key: string | null;
};

export function reloadDesiredFromRoom(room: Record<string, unknown> | null | undefined): ReloadDesiredState | null;

export function playbackContinuationDecision(input: {
  role: unknown;
  room: Record<string, unknown> | null | undefined;
  timeline: Record<string, unknown> | null | undefined;
  transportId: unknown;
  playbackGeneration: unknown;
}): PlaybackContinuationDecision;
