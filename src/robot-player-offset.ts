export interface RobotPlayerOffsetOptions {
  /** How long a report keeps the offset usable after it arrives. */
  freshForMs: number;
  /** How much recent history the reported value is drawn from. */
  windowMs: number;
  /** Reports outside the follower's residual range are convergence, not alignment. */
  maxAbsOffsetMs?: number;
  /**
   * How long a run of reports must last, and stop trending, before it is
   * aligned against. 0 settles on the first report.
   */
  settleMs?: number;
  /** How far the newer half of the window's median may sit from the older half's. */
  settleTrendMs?: number;
}

/**
 * The deployed player's reports spread about 19 ms peak-to-peak, so the
 * medians of two one-second halves differ by well under this when it holds
 * still; a player still converging at 20 ms/s moves them by about that much.
 */
const DEFAULT_SETTLE_TREND_MS = 15;

function median(values: number[]) {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = ordered.length >> 1;
  return ordered.length % 2 === 1 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
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
  private readonly maxAbsOffsetMs: number;
  private readonly settleMs: number;
  private readonly settleTrendMs: number;
  private samples: OffsetSample[] = [];
  private lastAtMs = -Infinity;
  private runStartedAtMs: number | null = null;
  private settledRun = false;

  constructor(options: RobotPlayerOffsetOptions) {
    this.freshForMs = options.freshForMs;
    this.windowMs = options.windowMs;
    this.maxAbsOffsetMs = options.maxAbsOffsetMs ?? Infinity;
    this.settleMs = Math.max(0, options.settleMs ?? 0);
    this.settleTrendMs = options.settleTrendMs ?? DEFAULT_SETTLE_TREND_MS;
  }

  record(offsetMs: number, nowMs: number) {
    if (!Number.isFinite(offsetMs)) return false;
    if (Math.abs(offsetMs) > this.maxAbsOffsetMs) {
      // Do not keep a previous residual fresh while the player is catching up,
      // or mix pre-convergence history into the first usable report afterwards.
      this.reset();
      return false;
    }
    this.samples.push({ offsetMs, atMs: nowMs });
    this.lastAtMs = nowMs;
    this.runStartedAtMs ??= nowMs;
    this.prune(nowMs);
    if (!this.settledRun) this.settledRun = this.runSettles(nowMs);
    return true;
  }

  reset() {
    this.samples = [];
    this.lastAtMs = -Infinity;
    this.runStartedAtMs = null;
    this.settledRun = false;
  }

  /**
   * Whether the reports since the last reset have settled. Latched until the
   * next reset, so report noise cannot take timing authority away and give it
   * back.
   *
   * Right after a song starts the player is still converging on its target:
   * on 2026-11-14 the first report a second in read -402 ms, a catch-up report
   * past the residual range reset the run three seconds later, and the
   * reports then went -317, -306 and -284 over the next thirty seconds. The
   * boot calibration had applied -312, was revoked, and applied -221: a 91 ms
   * jump in the voice. A run counts once it has lasted `settleMs` and the
   * newer half of the window no longer sits more than `settleTrendMs` from
   * the older half.
   */
  get settled() {
    return this.settledRun;
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

  private runSettles(nowMs: number) {
    if (this.settleMs === 0) return true;
    if (this.runStartedAtMs === null || nowMs - this.runStartedAtMs < this.settleMs) return false;
    const middleMs = nowMs - this.windowMs / 2;
    const older = this.samples.filter((sample) => sample.atMs < middleMs).map((sample) => sample.offsetMs);
    const newer = this.samples.filter((sample) => sample.atMs >= middleMs).map((sample) => sample.offsetMs);
    if (older.length === 0 || newer.length === 0) return false;
    return Math.abs(median(newer) - median(older)) <= this.settleTrendMs;
  }

  private prune(nowMs: number) {
    const horizon = nowMs - this.windowMs;
    this.samples = this.samples.filter((sample) => sample.atMs >= horizon);
  }
}
