export type PublisherActivationRequest<TSocket, TOwnershipEffects> = {
  socket: TSocket;
  ownershipEffects: TOwnershipEffects | null;
  previousOwnerId: string | null;
  takeoverRequested: boolean;
  sampleRate: number;
  captureGeneration: number | null;
  initialSequence?: number;
  audioPacketVersion: 1 | 2;
};

type PublisherBindResult<TSocket> = {
  previousPublisher: TSocket | null;
  sameParticipantReplacement: boolean;
  sameCapture: boolean;
};

type PublisherActivationOptions<TSocket, TOwnershipEffects> = {
  now(): number;
  participantId(socket: TSocket): string | null;
  applyOwnershipEffects(
    effects: TOwnershipEffects,
    hooks: {
      invalidateTiming(reason: string): void;
      prepareSongHandoff(participantId: string): void;
    },
  ): void;
  bindPublisher(registration: {
    socket: TSocket;
    sampleRate: number;
    captureGeneration: number | null;
    initialSequence?: number;
    audioPacketVersion: 1 | 2;
    nowMs: number;
  }): PublisherBindResult<TSocket>;
  retirePrevious(
    previousPublisher: TSocket,
    nextPublisher: TSocket,
    sameParticipantReplacement: boolean,
  ): void;
  cancelTransportGrace(): void;
  setMicExpected(): void;
  sessionActive(): boolean;
  noteTransportConnected(): void;
  invalidateTiming(reason: string): void;
  restartLiveSource(): void;
  directMediaOffer(): unknown;
  sendRegistered(socket: TSocket, result: {
    takeover: boolean;
    mediaTransport: unknown;
  }): void;
  sendInitialState(socket: TSocket): void;
  broadcastStatus(): void;
  broadcastSessionStatus(): void;
  beginPreparedSongHandoff(participantId: string): void;
};

/**
 * Preserves the post-authority publisher activation transaction. Participant
 * admission, Mic lease/CAS decisions, socket-role commit, transport/runtime
 * ownership, timing effects, Take quality and broadcasts stay in server-owned
 * callbacks.
 */
export function createRelayPublisherActivationCoordinator<TSocket, TOwnershipEffects>(
  options: PublisherActivationOptions<TSocket, TOwnershipEffects>,
) {
  return {
    activate(request: PublisherActivationRequest<TSocket, TOwnershipEffects>) {
      let deferredOwnershipTimingReason: string | null = null;
      let deferredHandoffParticipantId: string | null = null;

      if (request.ownershipEffects) {
        options.applyOwnershipEffects(request.ownershipEffects, {
          invalidateTiming: (reason) => {
            deferredOwnershipTimingReason = reason;
          },
          prepareSongHandoff: (participantId) => {
            deferredHandoffParticipantId = participantId;
          },
        });
      }

      const {
        previousPublisher,
        sameParticipantReplacement,
        sameCapture,
      } = options.bindPublisher({
        socket: request.socket,
        sampleRate: request.sampleRate,
        captureGeneration: request.captureGeneration,
        initialSequence: request.initialSequence,
        audioPacketVersion: request.audioPacketVersion,
        nowMs: options.now(),
      });

      if (previousPublisher && previousPublisher !== request.socket) {
        options.retirePrevious(
          previousPublisher,
          request.socket,
          sameParticipantReplacement,
        );
      }

      options.cancelTransportGrace();
      options.setMicExpected();
      if (!previousPublisher && options.sessionActive()) {
        options.noteTransportConnected();
      }

      if (deferredOwnershipTimingReason) {
        options.invalidateTiming(deferredOwnershipTimingReason);
      } else if (sameParticipantReplacement && !sameCapture) {
        options.invalidateTiming('Microphone capture changed.');
      }

      options.restartLiveSource();
      const participantId = options.participantId(request.socket);
      options.sendRegistered(request.socket, {
        takeover: request.takeoverRequested && request.previousOwnerId !== participantId,
        mediaTransport: options.directMediaOffer(),
      });
      options.sendInitialState(request.socket);
      options.broadcastStatus();

      if (participantId) {
        options.broadcastSessionStatus();
        if (deferredHandoffParticipantId) {
          options.beginPreparedSongHandoff(deferredHandoffParticipantId);
        }
      }
    },
  } as const;
}
