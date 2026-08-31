export type RelayCommandPayload = Record<string, unknown>;

type RelayCommandHandler<TSocket> = (
  socket: TSocket,
  payload: RelayCommandPayload,
) => void;

type RelayCommandProtocolHandlers<TSocket> = {
  startTake: RelayCommandHandler<TSocket>;
  stopTake: RelayCommandHandler<TSocket>;
  releaseMic: RelayCommandHandler<TSocket>;
  roomSongCommand: RelayCommandHandler<TSocket>;
  participantRename: RelayCommandHandler<TSocket>;
  rejectMicReservation: RelayCommandHandler<TSocket>;
  playbackMicIntent: RelayCommandHandler<TSocket>;
};

/**
 * Selects extracted mutating control commands without taking ownership of their
 * state. Domain/session/transport effects remain in the handlers supplied by
 * the server composition boundary.
 */
export function createRelayCommandProtocol<TSocket>(
  handlers: RelayCommandProtocolHandlers<TSocket>,
) {
  return {
    dispatch(socket: TSocket, payload: RelayCommandPayload) {
      switch (payload.type) {
        case 'start-take':
          handlers.startTake(socket, payload);
          return true;
        case 'stop-take':
          handlers.stopTake(socket, payload);
          return true;
        case 'release-mic':
          handlers.releaseMic(socket, payload);
          return true;
        case 'room-song-command':
          handlers.roomSongCommand(socket, payload);
          return true;
        case 'participant-rename':
          handlers.participantRename(socket, payload);
          return true;
        case 'acquire-mic':
        case 'force-acquire-mic':
          handlers.rejectMicReservation(socket, payload);
          return true;
        case 'playback-mic-intent':
          handlers.playbackMicIntent(socket, payload);
          return true;
        default:
          return false;
      }
    },
  } as const;
}
