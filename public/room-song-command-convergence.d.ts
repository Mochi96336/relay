export type RoomSongConvergenceStage = 'none' | 'intermediate' | 'complete';

export type RoomSongDesiredLike = {
  videoId: string;
  positionSeconds: number;
  state: number;
  playbackRate: number;
  mustApplyPosition?: boolean;
};

export type RoomSongObservedLike = {
  videoId: string | null;
  currentTime: number;
  state: number;
  playbackRate: number;
};

export const ROOM_SONG_POSITION_TOLERANCE_SECONDS: number;
export const ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS: number;

export function roomSongCommandConvergence(input: {
  desired: RoomSongDesiredLike | null | undefined;
  observed: RoomSongObservedLike | null | undefined;
  projectedPositionSeconds?: number;
  requirePosition?: boolean;
  positionToleranceSeconds?: number;
}): RoomSongConvergenceStage;

export function roomSongCommandExplainsLocalDelta(input: {
  desired: RoomSongDesiredLike | null | undefined;
  timelineDeltaSeconds: number;
  elapsedSinceApplySeconds: number;
}): boolean;
