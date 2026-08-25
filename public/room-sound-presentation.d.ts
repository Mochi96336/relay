export interface RoomSoundPresentationState {
  state?: string;
  phase?: string;
  forcedReason?: unknown;
  muted?: boolean;
}

export interface RoomSoundPresentationCopy {
  toggleKey: string;
  noteKey: string | null;
}

export interface RoomSoundControlPresentationCopy {
  labelKey: string;
  scopeKey: string;
  volumeLabelKey: string;
  volumeAriaLabelKey: string;
  toggleAriaLabelKey: string;
  iconState: 'audible' | 'muted' | 'retry';
}

export function roomSoundControlPresentation(
  detail?: RoomSoundPresentationState,
): RoomSoundControlPresentationCopy;

export function roomSoundStableNote(
  detail?: RoomSoundPresentationState,
): string | null;

export function roomSoundActionNote(
  detail?: RoomSoundPresentationState,
): string | null;

export function roomSoundPresentation(
  detail?: RoomSoundPresentationState,
): RoomSoundPresentationCopy;
