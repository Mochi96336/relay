export declare const ROOM_SONG_SEEK_TOLERANCE_SECONDS: number;

export declare function shouldSeekForRoomCommand(input?: {
  action?: unknown;
  videoChanged?: boolean;
  currentSeconds?: unknown;
  desiredSeconds?: unknown;
  toleranceSeconds?: unknown;
}): boolean;

export declare function shouldSetPlaybackRate(input?: {
  currentRate?: unknown;
  desiredRate?: unknown;
}): boolean;
