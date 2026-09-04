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
   * A room has exactly one source discontinuity authority.
   *
   * While a Robot source owns playback, only that Robot may report one. A
   * legacy Source page is the desktop development adapter: in a mixed
   * deployment its seeks describe a player Relay is not listening to, so
   * honouring them would let a page that owns nothing invalidate the active
   * Robot's content mapping and calibration.
   *
   * With no Robot attached, a legacy Source keeps its old authority - that is
   * the whole development path. A superseded Robot stays fenced either way,
   * even though its marker is reset to false.
   */
  canReportSeek(socket: TSocket) {
    if (this.activeRobotSocket !== null) return this.isActiveRobot(socket);
    return socket.isRobotSource === undefined;
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
