export type RoomPlaybackTarget = {
  videoId: string;
  positionSeconds: number;
  state: 1 | 5;
  playbackRate: number;
  ended: boolean;
};
export function playbackTargetState(roomState: unknown): 1 | 5;
export function playbackStartPosition(room: Record<string, unknown> | null | undefined): number;
export function roomPlaybackTarget(room: Record<string, unknown> | null | undefined): RoomPlaybackTarget | null;
