export interface RoomSoundPresentationState {
  state?: string;
  phase?: string;
}

export interface RoomSoundPresentationCopy {
  toggle: string;
  note: string;
}

export function roomSoundPresentation(
  detail?: RoomSoundPresentationState,
  isChinese?: boolean,
): RoomSoundPresentationCopy;
