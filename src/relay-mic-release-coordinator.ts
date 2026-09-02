export type RelayMicReleaseInput<TSocket, TEffects> = {
  socket: TSocket;
  participantId: string;
  effects: TEffects;
};

export type RelayMicReleaseHooks = {
  afterQualityEvent: () => void;
  beforeTimingInvalidation: () => void;
};

export type RelayMicReleaseDependencies<TSocket, TEffects> = {
  publisherParticipantId: () => string | null;
  mediaOwnerId: () => string | null;
  revokePublisherTransport: (message: string) => void;
  clearMediaAuthority: () => void;
  cancelTransportGrace: () => void;
  applyOwnershipEffects: (effects: TEffects, hooks: RelayMicReleaseHooks) => void;
  broadcastSessionStatus: () => void;
  sendReleased: (socket: TSocket) => void;
};

/**
 * Orders adapter effects after ParticipantSession has already committed a Mic
 * release. Lease authority deliberately stays in server.ts; this coordinator
 * only makes transport cleanup happen exactly once and before timing can be
 * invalidated for the released owner.
 */
export function createRelayMicReleaseCoordinator<TSocket, TEffects>(
  dependencies: RelayMicReleaseDependencies<TSocket, TEffects>,
) {
  return {
    release(input: RelayMicReleaseInput<TSocket, TEffects>) {
      let transportCleaned = false;
      const cleanReleasedTransport = () => {
        if (transportCleaned) return;
        transportCleaned = true;

        if (dependencies.publisherParticipantId() === input.participantId) {
          dependencies.revokePublisherTransport('You released the microphone.');
        } else if (dependencies.mediaOwnerId() === input.participantId) {
          dependencies.clearMediaAuthority();
        }
      };

      dependencies.applyOwnershipEffects(input.effects, {
        afterQualityEvent: () => dependencies.cancelTransportGrace(),
        beforeTimingInvalidation: cleanReleasedTransport,
      });

      // Successful release currently invalidates timing, but transport cleanup
      // must remain guaranteed even if that domain effect changes later.
      cleanReleasedTransport();
      dependencies.broadcastSessionStatus();
      dependencies.sendReleased(input.socket);
    },
  };
}
