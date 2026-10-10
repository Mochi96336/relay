// One full context replacement per explicit Mic session, never per PCM packet.
export class CaptureClockRecovery {
  constructor() { this.reset(); }
  reset() { this.base = null; this.slowWindows = 0; this.spent = false; }
  observe(snapshot) {
    const { nowMs, contextTime, visible, contextState, inputMuted } = snapshot;
    if (this.spent) return false;
    if (!visible || inputMuted || contextState !== 'running'
      || !Number.isFinite(nowMs) || !Number.isFinite(contextTime)) {
      this.base = null; this.slowWindows = 0; return false;
    }
    if (!this.base || nowMs <= this.base.nowMs || contextTime < this.base.contextTime) {
      this.base = { nowMs, contextTime }; this.slowWindows = 0; return false;
    }
    const wallMs = nowMs - this.base.nowMs;
    if (wallMs < 5000) return false;
    const contextMs = (contextTime - this.base.contextTime) * 1000;
    this.base = { nowMs, contextTime };
    // A stopped graph already belongs to the existing stall recovery path.
    this.slowWindows = contextMs > 0 && contextMs / wallMs < .85
      ? this.slowWindows + 1 : 0;
    if (this.slowWindows < 2) return false;
    this.spent = true;
    return true;
  }
}
