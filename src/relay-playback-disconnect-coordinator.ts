import type { PlaybackIdentity } from './song-session.js';

type PendingPlaybackCommand = {
  commandId: string;
};

type RelayPlaybackDisconnectCoordinatorOptions<TSocket> = {
  identity(socket: TSocket): PlaybackIdentity | null;
  now(): number;
  pendingCommand(identity: PlaybackIdentity, nowMs: number): PendingPlaybackCommand | null;
  failPending(identity: PlaybackIdentity, commandId: string): boolean;
  reportCommandFailure(commandId: string, nowMs: number): void;
  detachTimeline(identity: PlaybackIdentity): boolean;
  reportTimelineChanged(): void;
};

/**
 * Orders playback-only socket-close effects without owning song or command state.
 * The server-supplied callbacks remain the authority for room commands, timeline
 * mutation and broadcasts. Robot, Mic, Backing and participant close handling
 * intentionally stay outside this seam.
 */
export function createRelayPlaybackDisconnectCoordinator<TSocket>(
  options: RelayPlaybackDisconnectCoordinatorOptions<TSocket>,
) {
  return {
    handle(socket: TSocket) {
      const identity = options.identity(socket);
      if (!identity) return false;

      const nowMs = options.now();
      const pending = options.pendingCommand(identity, nowMs);
      if (pending && options.failPending(identity, pending.commandId)) {
        options.reportCommandFailure(pending.commandId, nowMs);
      }

      if (options.detachTimeline(identity)) options.reportTimelineChanged();
      return true;
    },
  } as const;
}
