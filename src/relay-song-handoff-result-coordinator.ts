export type RelaySongHandoffResultDependencies<TIdentity, TPlan> = {
  markReady: (identity: TIdentity, handoffId: unknown, micOwnerId: string | null) => TPlan | null;
  defer: (identity: TIdentity, handoffId: unknown) => boolean;
  sendCommit: (plan: TPlan) => void;
  reportTimelineStatus: () => void;
  reportRoomStatus: () => void;
};

/**
 * Orders song-handoff result effects after the server has resolved playback
 * identity. SongSession remains authoritative behind the mark/defer callbacks,
 * including handoff-id validation; this coordinator only preserves result
 * handling and publication ordering.
 */
export function createRelaySongHandoffResultCoordinator<TIdentity, TPlan>(
  dependencies: RelaySongHandoffResultDependencies<TIdentity, TPlan>,
) {
  return {
    ready(input: { identity: TIdentity; handoffId: unknown; micOwnerId: string | null }) {
      const plan = dependencies.markReady(input.identity, input.handoffId, input.micOwnerId);
      if (!plan) return false;

      dependencies.sendCommit(plan);
      dependencies.reportTimelineStatus();
      dependencies.reportRoomStatus();
      return true;
    },

    failed(input: { identity: TIdentity; handoffId: unknown }) {
      if (!dependencies.defer(input.identity, input.handoffId)) return false;

      dependencies.reportTimelineStatus();
      dependencies.reportRoomStatus();
      return true;
    },
  };
}
