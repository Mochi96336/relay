export type RelayPlaybackRegistrationContinuationDependencies<
  TSocket,
  TIdentity,
  THandoffPlan,
  TCommand,
> = {
  sendRegistered: (socket: TSocket, identity: TIdentity) => void;
  sendRoomStatus: (socket: TSocket) => void;
  sendCommandStatus: (socket: TSocket) => void;
  handoffPlanForTarget: (identity: TIdentity) => THandoffPlan | null;
  sendHandoffPrepare: (plan: THandoffPlan) => void;
  now: () => number;
  pendingCommandForTarget: (identity: TIdentity, nowMs: number) => TCommand | null;
  sendCommandApply: (identity: TIdentity, command: TCommand) => void;
};

export function createRelayPlaybackRegistrationContinuationCoordinator<
  TSocket,
  TIdentity,
  THandoffPlan,
  TCommand,
>(dependencies: RelayPlaybackRegistrationContinuationDependencies<
  TSocket,
  TIdentity,
  THandoffPlan,
  TCommand
>) {
  return {
    continueRegistration(input: { socket: TSocket; identity: TIdentity }) {
      dependencies.sendRegistered(input.socket, input.identity);
      dependencies.sendRoomStatus(input.socket);
      dependencies.sendCommandStatus(input.socket);

      const pendingPlan = dependencies.handoffPlanForTarget(input.identity);
      if (pendingPlan) dependencies.sendHandoffPrepare(pendingPlan);

      const pendingCommand = dependencies.pendingCommandForTarget(
        input.identity,
        dependencies.now(),
      );
      if (pendingCommand) dependencies.sendCommandApply(input.identity, pendingCommand);
    },
  };
}
