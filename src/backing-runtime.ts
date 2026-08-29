export type BackingRuntimeOptions<TSocket> = {
  graceMs: number;
  isConnected: (socket: TSocket) => boolean;
  onGraceExpired: () => void;
};

export type BackingRuntimeBindInput<TSocket> = {
  socket: TSocket;
  sampleRate: number;
  robot: boolean;
};

export type BackingRuntimeBindResult<TSocket> = {
  previous: TSocket | null;
  sameSocket: boolean;
};

export class BackingRuntime<TSocket> {
  private readonly graceMs: number;
  private readonly isConnectedSocket: (socket: TSocket) => boolean;
  private readonly onGraceExpired: () => void;

  private currentSocket: TSocket | null = null;
  private currentSampleRate: number | null = null;
  private robotRoute = false;
  private lastFrameAtMs = Number.NEGATIVE_INFINITY;
  private absenceTimer: NodeJS.Timeout | null = null;

  constructor(options: BackingRuntimeOptions<TSocket>) {
    if (!Number.isFinite(options.graceMs) || options.graceMs <= 0) {
      throw new Error('BackingRuntime graceMs must be positive.');
    }
    this.graceMs = options.graceMs;
    this.isConnectedSocket = options.isConnected;
    this.onGraceExpired = options.onGraceExpired;
  }

  get socket() {
    return this.currentSocket;
  }

  get sampleRate() {
    return this.currentSampleRate;
  }

  get isRobot() {
    return this.robotRoute;
  }

  get lastFrameAt() {
    return this.lastFrameAtMs;
  }

  get gracePending() {
    return this.absenceTimer !== null;
  }

  isSocket(socket: TSocket) {
    return socket === this.currentSocket;
  }

  connected() {
    return this.currentSocket !== null && this.isConnectedSocket(this.currentSocket);
  }

  armed() {
    return this.connected() || this.gracePending;
  }

  streaming(nowMs: number, liveForMs: number) {
    return Number.isFinite(nowMs)
      && Number.isFinite(liveForMs)
      && liveForMs > 0
      && nowMs - this.lastFrameAtMs < liveForMs;
  }

  bind(input: BackingRuntimeBindInput<TSocket>): BackingRuntimeBindResult<TSocket> {
    if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0) {
      throw new Error('BackingRuntime sampleRate must be positive.');
    }

    const previous = this.currentSocket;
    const sameSocket = previous === input.socket;
    this.cancelGrace();
    if (!sameSocket) this.lastFrameAtMs = Number.NEGATIVE_INFINITY;
    this.currentSocket = input.socket;
    this.currentSampleRate = input.sampleRate;
    this.robotRoute = input.robot;
    return { previous, sameSocket };
  }

  noteFrame(socket: TSocket, nowMs: number) {
    if (socket !== this.currentSocket || !Number.isFinite(nowMs)) return false;
    this.lastFrameAtMs = nowMs;
    return true;
  }

  detach(socket: TSocket) {
    if (socket !== this.currentSocket) return false;
    this.currentSocket = null;
    this.currentSampleRate = null;
    this.lastFrameAtMs = Number.NEGATIVE_INFINITY;
    this.scheduleGrace();
    return true;
  }

  cancelGrace() {
    if (this.absenceTimer === null) return false;
    clearTimeout(this.absenceTimer);
    this.absenceTimer = null;
    return true;
  }

  retireRobotRoute() {
    this.robotRoute = false;
  }

  private scheduleGrace() {
    this.cancelGrace();
    this.absenceTimer = setTimeout(() => {
      this.absenceTimer = null;
      this.onGraceExpired();
    }, this.graceMs);
  }
}
