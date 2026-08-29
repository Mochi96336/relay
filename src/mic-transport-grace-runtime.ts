export type MicTransportGraceRuntimeOptions = {
  graceMs: number;
  onExpired: (ownerId: string) => void;
};

/**
 * Owns only the Mic control-transport grace timer and the owner identity that
 * the timer was armed for. Mic lease authority, transport/media liveness and
 * release side effects remain outside this runtime.
 */
export class MicTransportGraceRuntime {
  private readonly graceMs: number;
  private readonly onExpired: (ownerId: string) => void;
  private currentOwnerId: string | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: MicTransportGraceRuntimeOptions) {
    if (!Number.isFinite(options.graceMs) || options.graceMs <= 0) {
      throw new Error('MicTransportGraceRuntime graceMs must be positive.');
    }
    this.graceMs = options.graceMs;
    this.onExpired = options.onExpired;
  }

  get ownerId() {
    return this.currentOwnerId;
  }

  get pending() {
    return this.timer !== null;
  }

  schedule(ownerId: string) {
    if (!ownerId) throw new Error('MicTransportGraceRuntime ownerId is required.');
    this.cancel();
    this.currentOwnerId = ownerId;
    this.timer = setTimeout(() => {
      this.timer = null;
      const expiredOwnerId = this.currentOwnerId;
      this.currentOwnerId = null;
      if (expiredOwnerId) this.onExpired(expiredOwnerId);
    }, this.graceMs);
    this.timer.unref();
  }

  cancel() {
    const hadPending = this.timer !== null || this.currentOwnerId !== null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.currentOwnerId = null;
    return hadPending;
  }
}
