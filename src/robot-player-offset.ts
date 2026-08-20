export interface RobotPlayerOffsetOptions {
  /** How long a report keeps the offset usable after it arrives. */
  freshForMs: number;
  /** How much recent history the reported value is drawn from. */
  windowMs: number;
}

interface OffsetSample {
  offsetMs: number;
  atMs: number;
}

/**
 * Holds the robot player's reported playback error steady enough to drive audio
 * alignment.
 *
 * The robot publishes `currentTime - target` roughly every 250 ms, straight from
 * a YouTube IFrame player. That number is genuinely noisy: the measured spread
 * on the deployed Raspberry Pi is around 19 ms peak-to-peak while the underlying
 * playback position drifts by well under 1 ms/s. Consuming it raw meant a
 * ±20 ms wobble repeatedly crossed the re-apply threshold, and every crossing
 * re-anchored the microphone timeline - an instant, audible splice in the voice
 * for what was never real movement.
 *
 * A median over the recent window rejects those outliers while still tracking
 * drift that persists. Freshness deliberately remains a property of arrival
 * rather than of the smoothed value: a robot that stops reporting loses timing
 * authority at exactly the moment it always did, regardless of how much history
 * is still held.
 */
export class RobotPlayerOffsetTracker {
  private readonly freshForMs: number;
  private readonly windowMs: number;
  private samples: OffsetSample[] = [];
  private lastAtMs = -Infinity;

  constructor(options: RobotPlayerOffsetOptions) {
    this.freshForMs = options.freshForMs;
    this.windowMs = options.windowMs;
  }

  record(offsetMs: number, nowMs: number) {
    if (!Number.isFinite(offsetMs)) return;
    this.samples.push({ offsetMs, atMs: nowMs });
    this.lastAtMs = nowMs;
    this.prune(nowMs);
  }

  reset() {
    this.samples = [];
    this.lastAtMs = -Infinity;
  }

  /** When the most recent report arrived, for status surfaces. */
  get lastReportedAtMs() {
    return this.lastAtMs;
  }

  isFresh(nowMs: number) {
    return nowMs - this.lastAtMs <= this.freshForMs;
  }

  /**
   * The offset to align against, or null once nothing recent has been reported.
   *
   * Pruning happens on read as well as on write so a robot that goes quiet
   * cannot keep answering from history it has outlived.
   */
  offsetMs(nowMs: number): number | null {
    this.prune(nowMs);
    if (this.samples.length === 0) return null;

    const ordered = this.samples.map((sample) => sample.offsetMs).sort((a, b) => a - b);
    const middle = ordered.length >> 1;
    return ordered.length % 2 === 1
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  /** The newest report as sent, for diagnostics that must not see smoothing. */
  rawOffsetMs(nowMs: number): number | null {
    this.prune(nowMs);
    return this.samples.at(-1)?.offsetMs ?? null;
  }

  private prune(nowMs: number) {
    const horizon = nowMs - this.windowMs;
    this.samples = this.samples.filter((sample) => sample.atMs >= horizon);
  }
}
