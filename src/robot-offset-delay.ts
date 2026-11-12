/**
 * How stale the Robot's target was when it measured its player against it.
 *
 * The Robot page compares its player with the target in the timeline status
 * it was just handed. The status was computed some milliseconds earlier, and
 * the player kept playing meanwhile, so the offset it reports is too large by
 * that delay: always the same way, like every report that takes time. Nothing
 * subtracts it. This measures it: the target the Robot says it used, against
 * where the same target stands when its report arrives. That span is the
 * status's way to the page, the page's wait before handling it, and the
 * report's way back, all on this host.
 *
 * Measurement only. Whether to subtract it depends on how large it is on the
 * Pi under a real session, which the journal line answers.
 */
export type RobotOffsetDelaySummary = { samples: number; medianMs: number; p90Ms: number; maxMs: number };

export class RobotOffsetDelay {
  private delays: number[] = [];
  private windowStartedAtMs: number | null = null;
  private last: number | null = null;

  constructor(private readonly summaryEveryMs = 30_000, private readonly maxDelayMs = 1_000) {}

  /** The newest measured delay; null when the last report could not be measured. */
  get lastMs() { return this.last; }

  /**
   * `reportedTargetSeconds` is the target the Robot measured against,
   * `currentTargetSeconds` the same target now. Returns a summary once per
   * interval, for the journal.
   */
  note(reportedTargetSeconds: number, currentTargetSeconds: number, playbackRate: number, nowMs: number)
    : RobotOffsetDelaySummary | null {
    const delayMs = ((currentTargetSeconds - reportedTargetSeconds) * 1000) / playbackRate;
    // A seek, a new song or a pause between the two readings is not a delay.
    if (!Number.isFinite(delayMs) || !(playbackRate > 0) || delayMs < 0 || delayMs > this.maxDelayMs) {
      this.last = null;
      return null;
    }
    this.last = delayMs;
    this.delays.push(delayMs);
    this.windowStartedAtMs ??= nowMs;
    if (nowMs - this.windowStartedAtMs < this.summaryEveryMs) return null;
    const sorted = this.delays.sort((a, b) => a - b);
    const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
    const summary = { samples: sorted.length, medianMs: Math.round(at(.5) * 10) / 10,
      p90Ms: Math.round(at(.9) * 10) / 10, maxMs: Math.round(sorted.at(-1)! * 10) / 10 };
    this.reset();
    return summary;
  }

  reset() {
    this.delays = [];
    this.windowStartedAtMs = null;
  }
}
