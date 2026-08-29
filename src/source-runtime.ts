export type SourceRuntimeSocket = {
  isRobotSource?: boolean;
};

export type SourceRuntimeOptions<TSocket extends SourceRuntimeSocket> = {
  isConnected: (socket: TSocket) => boolean;
};

export type SourceRuntimeAttachResult<TSocket extends SourceRuntimeSocket> = {
  previous: TSocket | null;
  replaced: boolean;
};

/**
 * Owns Desktop Source control identity and its discontinuity generation.
 *
 * Media transport, Robot timeline mapping, calibration, Take quality policy,
 * and disconnect side effects stay with their existing domain owners. This
 * runtime answers only which Robot control source is authoritative and when a
 * destructive source discontinuity advances the shared source generation.
 */
export class SourceRuntime<TSocket extends SourceRuntimeSocket> {
  private readonly isConnectedSocket: (socket: TSocket) => boolean;
  private activeRobotSocket: TSocket | null = null;
  private sourceGeneration = 0;

  constructor(options: SourceRuntimeOptions<TSocket>) {
    this.isConnectedSocket = options.isConnected;
  }

  get socket() {
    return this.activeRobotSocket;
  }

  get generation() {
    return this.sourceGeneration;
  }

  connected() {
    return this.activeRobotSocket !== null && this.isConnectedSocket(this.activeRobotSocket);
  }

  isActive(socket: TSocket) {
    return socket === this.activeRobotSocket;
  }

  isActiveRobot(socket: TSocket) {
    return this.isActive(socket) && socket.isRobotSource === true;
  }

  /**
   * Legacy Source sockets never enter the Robot lifecycle and keep their old
   * seek authority. Once a socket has been a Robot source, only the currently
   * active Robot may report source discontinuities; a superseded socket stays
   * fenced even though its marker is reset to false.
   */
  canReportSeek(socket: TSocket) {
    return socket.isRobotSource === undefined || this.isActiveRobot(socket);
  }

  attachRobot(socket: TSocket): SourceRuntimeAttachResult<TSocket> {
    const previous = this.activeRobotSocket;
    if (previous === socket) {
      socket.isRobotSource = true;
      return { previous, replaced: false };
    }

    const replaced = previous !== null;
    if (previous) previous.isRobotSource = false;
    if (replaced) this.sourceGeneration += 1;

    this.activeRobotSocket = socket;
    socket.isRobotSource = true;
    return { previous, replaced };
  }

  detachRobot(socket: TSocket) {
    if (!this.isActive(socket)) return false;
    this.activeRobotSocket = null;
    socket.isRobotSource = false;
    this.sourceGeneration += 1;
    return true;
  }

  invalidateMapping() {
    this.sourceGeneration += 1;
    return this.sourceGeneration;
  }
}
