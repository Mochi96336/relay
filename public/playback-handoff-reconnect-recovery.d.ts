export type PlaybackHandoffRecoveredTerminal = {
  type: 'song-handoff-complete' | 'song-handoff-cancelled';
  handoffId: string;
  recoveredAfterReconnect: true;
};

export type PlaybackReconnectIdentity = {
  participantId: string;
  transportId: string;
  generation: number;
};

export type PlaybackReconnectTimeline = {
  playbackLeaderParticipantId?: unknown;
  playbackTransportId?: unknown;
  playbackGeneration?: unknown;
  handoffState?: unknown;
  handoffId?: unknown;
};

export type PlaybackHandoffReconnectRecovery = {
  notePrepare(handoffId: unknown): void;
  noteCommit(handoffId: unknown): void;
  noteComplete(handoffId: unknown): void;
  noteCancelled(): void;
  noteSocketClosed(): void;
  noteTimeline(
    status: PlaybackReconnectTimeline | null | undefined,
    identity: PlaybackReconnectIdentity | null | undefined,
  ): boolean;
};

export function createPlaybackHandoffReconnectRecovery(
  emitTerminal: (message: PlaybackHandoffRecoveredTerminal) => void,
): PlaybackHandoffReconnectRecovery;
