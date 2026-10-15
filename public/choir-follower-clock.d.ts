export type ProjectedFollowerRoom = {
  videoId: string;
  revision: number;
  positionSeconds: number;
  playbackRate: number;
  durationSeconds: number | null;
  playing: boolean;
  ageMs: number;
};
export declare const FOLLOWER_ROOM_MAX_AGE_MS: number;
export declare const FOLLOWER_SEEK_THRESHOLD_MS: number;
export declare const FOLLOWER_SEEK_COOLDOWN_MS: number;
export declare function projectFollowerRoom(
  room: {
    connected: boolean; handoffState: string; videoId: string;
    revision: number; state: number; serverTime: number;
    playbackRate: number; duration?: number;
  } | null,
  receivedAtMs: number | null,
  nowMs: number,
): ProjectedFollowerRoom | null;
export declare function decideFollowerAction(
  room: ProjectedFollowerRoom | null,
  local: {
    ready: boolean; videoId: string | null; positionSeconds: number;
    playbackRate: number; playerState: number;
  },
  nowMs: number,
  lastSeekAtMs: number,
):
  | { type: 'none'; driftMs: number | null }
  | { type: 'cue'; videoId: string; positionSeconds: number; driftMs: null }
  | { type: 'pause'; driftMs: number }
  | { type: 'rate'; playbackRate: number; driftMs: number }
  | { type: 'seek'; positionSeconds: number; driftMs: number }
  | { type: 'play'; driftMs: number };
