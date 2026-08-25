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
export const ROOM_SONG_RATE_TOLERANCE: number;

export function roomSongCommandConvergence(input: {
  desired: RoomSongDesiredLike | null | undefined;
  observed: RoomSongObservedLike | null | undefined;
  projectedPositionSeconds?: number;
  positionMinSeconds?: number;
  positionMaxSeconds?: number;
  requirePosition?: boolean;
  positionToleranceSeconds?: number;
}): RoomSongConvergenceStage;

export function roomSongCommandLocalDeltaEvidence(input: {
  desired: RoomSongDesiredLike | null | undefined;
  timelineDeltaSeconds: number;
  elapsedSinceApplySeconds: number;
  commandTransition?: boolean;
  correctionDebtSeconds?: number;
}): {
  explained: boolean;
  correctionDebtSeconds: number;
};
