export type RoomSongMutation = 'load' | 'play' | 'pause' | 'seek' | 'rate';

export function roomSongObservedMutations(input: {
  observed: Record<string, unknown> | null | undefined;
  room: Record<string, unknown> | null | undefined;
}): Set<RoomSongMutation>;

export function roomSongPendingOwnsMutation(input: {
  mutation: RoomSongMutation;
  commandAction?: RoomSongMutation;
  commandActions?: readonly RoomSongMutation[];
  desired: {
    positionSeconds: number;
    mustApplyPosition?: boolean;
  } | null | undefined;
  currentTime: number;
  projectedPositionSeconds: number;
}): boolean;
