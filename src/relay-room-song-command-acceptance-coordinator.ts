export type RelayAcceptedRoomSongCommand<TTarget> = {
  commandId: string;
  revision: number;
  target: TTarget;
};

export type RelayRoomSongCommandAcceptanceDependencies<
  TSocket,
  TTarget,
  TCommand extends RelayAcceptedRoomSongCommand<TTarget>,
> = {
  sendAccepted: (
    socket: TSocket,
    commandId: string,
    revision: number,
    duplicate: boolean,
  ) => void;
  pendingForTarget: (target: TTarget, nowMs: number) => TCommand | null;
  sendApply: (target: TTarget, command: TCommand) => void;
  reportStatus: (nowMs: number) => void;
};

export function createRelayRoomSongCommandAcceptanceCoordinator<
  TSocket,
  TTarget,
  TCommand extends RelayAcceptedRoomSongCommand<TTarget>,
>(dependencies: RelayRoomSongCommandAcceptanceDependencies<TSocket, TTarget, TCommand>) {
  return {
    accept(input: {
      socket: TSocket;
      command: TCommand;
      duplicate: boolean;
      nowMs: number;
    }) {
      dependencies.sendAccepted(
        input.socket,
        input.command.commandId,
        input.command.revision,
        input.duplicate,
      );

      const stillPending = dependencies.pendingForTarget(input.command.target, input.nowMs);
      if (stillPending?.commandId === input.command.commandId) {
        dependencies.sendApply(input.command.target, input.command);
      }

      dependencies.reportStatus(input.nowMs);
    },
  };
}
