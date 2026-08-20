export interface RoomSoundPresentationState {
  state?: string;
  phase?: string;
  forcedReason?: unknown;
  muted?: boolean;
}

export interface RoomSoundPresentationCopy {
  toggle: string;
  note: string;
}

export interface RoomSoundControlPresentationCopy {
  label: string;
  scope: string;
  volumeLabel: string;
  volumeAriaLabel: string;
  toggleAriaLabel: string;
  compact: string;
}

export function roomSoundControlPresentation(
  detail?: RoomSoundPresentationState,
  isChinese?: boolean,
): RoomSoundControlPresentationCopy;

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
