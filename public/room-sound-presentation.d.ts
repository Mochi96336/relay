export interface RoomSoundPresentationState {
  state?: string;
  phase?: string;
}

export interface RoomSoundPresentationCopy {
  toggle: string;
  note: string;
}

export function roomSoundStableNote(
  detail?: RoomSoundPresentationState,
  isChinese?: boolean,
): string;

export function roomSoundActionNote(
  detail?: RoomSoundPresentationState,
  isChinese?: boolean,
): string;

export function roomSoundPresentation(
  detail?: RoomSoundPresentationState,
  isChinese?: boolean,
): RoomSoundPresentationCopy;
