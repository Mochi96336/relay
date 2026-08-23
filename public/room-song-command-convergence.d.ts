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

/** Landing slack for explicit position mutations. Command delivery age is excluded. */
export const ROOM_SONG_POSITION_TOLERANCE_SECONDS: number;
export const ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS: number;
/** Causal iframe correction envelope for state-only commands; never position authority. */
export const ROOM_SONG_CAUSAL_CORRECTION_TOLERANCE_SECONDS: number;
/** Reload-only equivalence slack for restoring a terminal position on a fresh iframe. */
export const ROOM_SONG_TERMINAL_RELOAD_TOLERANCE_SECONDS: number;

export function roomSongCommandConvergence(input: {
  desired: RoomSongDesiredLike | null | undefined;
  observed: RoomSongObservedLike | null | undefined;
  /** Compatibility-only context. Explicit position proof always targets desired.positionSeconds. */
  projectedPositionSeconds?: number;
  requirePosition?: boolean;
  positionToleranceSeconds?: number;
}): RoomSongConvergenceStage;

export function roomSongCommandExplainsLocalDelta(input: {
  desired: RoomSongDesiredLike | null | undefined;
  timelineDeltaSeconds: number;
  elapsedSinceApplySeconds: number;
}): boolean;
