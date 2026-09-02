export type RelayBackingActivationInput<TSocket> = {
  socket: TSocket;
  sampleRate: number;
  robot: boolean;
};

export type RelayBackingActivationDependencies<TSocket> = {
  previousBacking: () => TSocket | null;
  clearRobotBackingBoundaryRequest: () => void;
  noteQualityEvent: (
    event: 'backing-transport-replaced' | 'backing-transport-connected',
  ) => void;
  retirePrevious: (previous: TSocket | null, next: TSocket) => void;
  setSocketSampleRate: (socket: TSocket, sampleRate: number) => void;
  bindBacking: (registration: {
    socket: TSocket;
    sampleRate: number;
    robot: boolean;
  }) => void;
  setBackingExpected: () => void;
  sessionActive: () => boolean;
  dropLegacyCalibrationForRobot: () => void;
  activeBackingIsRobot: () => boolean;
  sendRegistered: (socket: TSocket, robot: boolean) => void;
  startLiveSource: () => void;
};

/**
 * Orders Backing transport activation after registration authority has already
 * admitted the socket and committed its role.
 *
 * This seam deliberately owns no infrastructure authentication, socket-role
 * authority, sample-rate validation, BackingRuntime state, AudioSession state,
 * Take state, Robot calibration state, or source lifecycle state. Every domain
 * effect remains supplied by the server composition root.
 */
export function createRelayBackingActivationCoordinator<TSocket>(
  dependencies: RelayBackingActivationDependencies<TSocket>,
) {
  return {
    activate(input: RelayBackingActivationInput<TSocket>) {
      const previousBacking = dependencies.previousBacking();

      dependencies.clearRobotBackingBoundaryRequest();
      if (previousBacking && previousBacking !== input.socket) {
        dependencies.noteQualityEvent('backing-transport-replaced');
      }

      dependencies.retirePrevious(previousBacking, input.socket);
      dependencies.setSocketSampleRate(input.socket, input.sampleRate);
      dependencies.bindBacking({
        socket: input.socket,
        sampleRate: input.sampleRate,
        robot: input.robot,
      });
      dependencies.setBackingExpected();

      if (!previousBacking && dependencies.sessionActive()) {
        dependencies.noteQualityEvent('backing-transport-connected');
      }

      dependencies.dropLegacyCalibrationForRobot();
      dependencies.sendRegistered(input.socket, dependencies.activeBackingIsRobot());
      dependencies.startLiveSource();
    },
  };
}
