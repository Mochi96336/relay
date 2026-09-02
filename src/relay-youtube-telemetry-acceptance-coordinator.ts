export type RelayYoutubeTelemetryStatus = {
  state?: unknown;
  videoId?: unknown;
};

export type RelayYoutubeTelemetryAcceptanceInput<TSocket, TPlaybackIdentity> = {
  socket: TSocket;
  acceptedIdentity: TPlaybackIdentity;
  nowMs: number;
  timelineStatus: RelayYoutubeTelemetryStatus;
  completesCommandId?: string | null;
  handoffCompleted?: boolean;
  handoffId?: string | null;
  previousLeader?: TPlaybackIdentity | null;
};

export type RelayYoutubeTelemetryAcceptanceDependencies<TSocket, TPlaybackIdentity> = {
  registerPlayback: (socket: TSocket, identity: TPlaybackIdentity) => void;
  clearTelemetryRejection: (socket: TSocket) => void;
  cancelActiveContentValidation: (nowMs: number) => boolean;
  reportTimingStatus: () => void;
  reportTimelineStatus: (status: RelayYoutubeTelemetryStatus) => void;
  reportRoomStatus: (nowMs: number) => void;
  completeRoomSongCommand: (commandId: string) => boolean;
  reportRoomSongCommandComplete: (commandId: string) => void;
  reportRoomSongCommandStatus: (nowMs: number) => void;
  releasePreviousLeader: (
    previousLeader: TPlaybackIdentity,
    handoffId: string,
    videoId: unknown,
  ) => void;
  completeHandoff: (identity: TPlaybackIdentity, handoffId: string) => void;
};

/**
 * Orders adapter effects after SongSession has already accepted telemetry.
 * Playback identity, Room Song gating/completion authority, SongSession state,
 * validation authority and handoff authority remain behind server callbacks.
 */
export function createRelayYoutubeTelemetryAcceptanceCoordinator<TSocket, TPlaybackIdentity>(
  dependencies: RelayYoutubeTelemetryAcceptanceDependencies<TSocket, TPlaybackIdentity>,
) {
  return {
    accept(input: RelayYoutubeTelemetryAcceptanceInput<TSocket, TPlaybackIdentity>) {
      dependencies.registerPlayback(input.socket, input.acceptedIdentity);
      dependencies.clearTelemetryRejection(input.socket);

      if (
        Number(input.timelineStatus.state) !== 1
        && dependencies.cancelActiveContentValidation(input.nowMs)
      ) {
        dependencies.reportTimingStatus();
      }

      dependencies.reportTimelineStatus(input.timelineStatus);
      dependencies.reportRoomStatus(input.nowMs);

      if (
        input.completesCommandId
        && dependencies.completeRoomSongCommand(input.completesCommandId)
      ) {
        dependencies.reportRoomSongCommandComplete(input.completesCommandId);
        dependencies.reportRoomSongCommandStatus(input.nowMs);
      }

      if (input.handoffCompleted && input.handoffId) {
        if (input.previousLeader) {
          dependencies.releasePreviousLeader(
            input.previousLeader,
            input.handoffId,
            input.timelineStatus.videoId ?? null,
          );
        }
        dependencies.completeHandoff(input.acceptedIdentity, input.handoffId);
      }
    },
  };
}
