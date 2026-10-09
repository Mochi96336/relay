/**
 * A yes/no fact that changes only once its raw value has held the other way for
 * long enough, with a separate hold for each direction.
 *
 * Product status read Mic playability and audibility raw. On a congested
 * uplink on 2026-10-09 both flipped about once a second, and the attention
 * line came and went with them. A problem raised after a short hold and
 * cleared after a longer one shows once and stays while the Mic keeps failing.
 */
export class SteadyFlag {
  private readonly raiseMs: number;
  private readonly clearMs: number;
  private steady = false;
  private differingSinceMs: number | null = null;

  constructor({ raiseMs, clearMs }: { raiseMs: number; clearMs: number }) {
    if (!(raiseMs >= 0) || !(clearMs >= 0)) throw new RangeError('holds must be non-negative');
    this.raiseMs = raiseMs;
    this.clearMs = clearMs;
  }

  /** The steady value, given the raw value at `nowMs`. */
  update(raw: boolean, nowMs: number) {
    if (raw === this.steady) {
      this.differingSinceMs = null;
      return this.steady;
    }
    if (this.differingSinceMs === null || nowMs < this.differingSinceMs) this.differingSinceMs = nowMs;
    if (nowMs - this.differingSinceMs >= (raw ? this.raiseMs : this.clearMs)) {
      this.steady = raw;
      this.differingSinceMs = null;
    }
    return this.steady;
  }

  reset() {
    this.steady = false;
    this.differingSinceMs = null;
  }
}
