/**
 * Diagnostic estimate of how fast the phone's capture clock runs against
 * Relay's mix clock, in parts per million.
 *
 * The Mic timeline is anchored once, at capture start, and Mic packets are
 * never time-stretched afterwards. A capture clock that is slower than the mix
 * clock therefore spends the live headroom a little every second; a faster one
 * makes the voice drift later against the song. Whether that matters in a real
 * session depends entirely on the size of the error, which is what this
 * measures before anyone builds a correction for it.
 *
 * Packet arrival is dominated by network queueing, so a direct fit of arrival
 * time against capture position is mostly jitter. The lower envelope is not:
 * the least-delayed packet of each window rides on the base path latency, and
 * its drift across windows is the clock difference. Fit a line through those
 * per-window minima.
 *
 * The first window of a capture is discarded: capture start-up, the first
 * transport path choice and the mix beginning all land in it, and its minimum
 * is not base latency. The fit is Theil-Sen (median of pairwise slopes), so a
 * single disturbed window - a network change, a stalled page - cannot tilt it.
 * Nothing is reported before a minute of windows: packet arrival is quantised
 * to milliseconds, and over half a minute 2 ms of noise already reads as
 * 67 ppm, which on a real rehearsal looked like a badly drifting phone.
 *
 * A path change shifts base latency as a step - one 20 ms chunk of dispatch
 * phase, a new Wi-Fi access point - and every later window moves with it.
 * Clock drift cannot move the envelope that fast (200 ppm is 1 ms per window),
 * so a jump between consecutive windows beyond STEP_MS is spliced out before
 * fitting instead of being read as drift.
 */

const STEP_MS = 8;

export type MicClockDriftEstimate = {
  /** Positive: the capture clock runs slow, spending live headroom. */
  ppm: number;
  windows: number;
  spanMs: number;
};

export type MicClockDriftEstimatorOptions = {
  windowMs?: number;
  maxWindows?: number;
  minWindows?: number;
};

type WindowMinimum = { atMs: number; delaySamples: number };

export class MicClockDriftEstimator {
  readonly windowMs: number;
  readonly maxWindows: number;
  readonly minWindows: number;

  private generation: number | null = null;
  private sourceRate: number | null = null;
  private windowStartedAtMs: number | null = null;
  private windowMinimum: number | null = null;
  private warmupWindowPending = true;
  private readonly minima: WindowMinimum[] = [];
  /** Sum of spliced latency steps, in source samples. */
  private stepOffsetSamples = 0;
  private lastRawMinimum: number | null = null;
  /** Delay of the capture's first packet: the one AudioSession anchors to. */
  private anchorDelaySamples: number | null = null;
  /** Lowest delay of the first window after warm-up: the settled path. */
  private settledMinimumSamples: number | null = null;

  constructor(options: MicClockDriftEstimatorOptions = {}) {
    this.windowMs = options.windowMs ?? 5_000;
    this.maxWindows = options.maxWindows ?? 24;
    this.minWindows = options.minWindows ?? 12;
    if (!(this.windowMs > 0)) throw new RangeError('windowMs must be positive');
    if (!Number.isInteger(this.maxWindows) || this.maxWindows < 2) {
      throw new RangeError('maxWindows must be an integer of at least 2');
    }
    if (!Number.isInteger(this.minWindows) || this.minWindows < 2 || this.minWindows > this.maxWindows) {
      throw new RangeError('minWindows must be an integer from 2 to maxWindows');
    }
  }

  /**
   * One accepted positioned Mic packet: its capture generation, source rate,
   * the source-clock index just past its last sample, and when it arrived.
   */
  observe(generation: number, sourceRate: number, sourceEndSample: number, arrivedAtMs: number) {
    if (
      !Number.isFinite(sourceEndSample)
      || !Number.isFinite(arrivedAtMs)
      || !(sourceRate > 0)
    ) return;
    if (generation !== this.generation || sourceRate !== this.sourceRate) {
      // A new capture is a new clock anchor; nothing before it applies.
      this.generation = generation;
      this.sourceRate = sourceRate;
      this.windowStartedAtMs = null;
      this.windowMinimum = null;
      this.minima.length = 0;
      this.stepOffsetSamples = 0;
      this.lastRawMinimum = null;
      this.warmupWindowPending = true;
      this.anchorDelaySamples = null;
      this.settledMinimumSamples = null;
    }

    // Arrival on the mix clock minus capture position on the source clock,
    // both in source samples. Only its change over time matters.
    const delaySamples = (arrivedAtMs * sourceRate) / 1000 - sourceEndSample;
    if (this.anchorDelaySamples === null) this.anchorDelaySamples = delaySamples;
    if (this.windowStartedAtMs === null) this.windowStartedAtMs = arrivedAtMs;
    this.windowMinimum = this.windowMinimum === null
      ? delaySamples
      : Math.min(this.windowMinimum, delaySamples);

    if (arrivedAtMs - this.windowStartedAtMs >= this.windowMs) {
      if (this.warmupWindowPending) {
        this.warmupWindowPending = false;
      } else {
        const raw = this.windowMinimum;
        if (this.settledMinimumSamples === null) this.settledMinimumSamples = raw;
        if (this.lastRawMinimum !== null) {
          const jump = raw - this.lastRawMinimum;
          if (Math.abs(jump) > (STEP_MS * sourceRate) / 1000) this.stepOffsetSamples += jump;
        }
        this.lastRawMinimum = raw;
        this.minima.push({ atMs: arrivedAtMs, delaySamples: raw - this.stepOffsetSamples });
        if (this.minima.length > this.maxWindows) this.minima.shift();
      }
      this.windowStartedAtMs = arrivedAtMs;
      this.windowMinimum = null;
    }
  }

  /**
   * How much later than the settled path the capture's first packet arrived,
   * in ms, or null before the first window after warm-up closes.
   *
   * AudioSession anchors a capture's whole Mic timeline to its first packet's
   * arrival, so a first packet held up by start-up (a busy main thread, a
   * transport still being chosen) bakes that delay into the capture for as
   * long as it lasts. Calibration absorbs it, but the read-ahead budget is
   * sized as if it were not there, and nothing else reports it.
   */
  anchorExcessMs() {
    if (
      this.anchorDelaySamples === null
      || this.settledMinimumSamples === null
      || this.sourceRate === null
    ) return null;
    return Math.round(
      ((this.anchorDelaySamples - this.settledMinimumSamples) * 1000) / this.sourceRate,
    );
  }

  estimate(): MicClockDriftEstimate | null {
    if (this.minima.length < this.minWindows || this.sourceRate === null) return null;
    const n = this.minima.length;
    const slopes: number[] = [];
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const dt = this.minima[j]!.atMs - this.minima[i]!.atMs;
        if (dt > 0) slopes.push((this.minima[j]!.delaySamples - this.minima[i]!.delaySamples) / dt);
      }
    }
    if (slopes.length === 0) return null;
    slopes.sort((a, b) => a - b);
    const middle = slopes.length >> 1;
    // Slope in source samples per millisecond; a growing delay means the
    // capture clock produces samples slower than real time.
    const slopeSamplesPerMs = slopes.length % 2 === 1
      ? slopes[middle]!
      : (slopes[middle - 1]! + slopes[middle]!) / 2;
    const ppm = (slopeSamplesPerMs * 1000 * 1e6) / this.sourceRate;
    return {
      ppm: Math.round(ppm * 10) / 10,
      windows: n,
      spanMs: Math.round(this.minima[n - 1]!.atMs - this.minima[0]!.atMs),
    };
  }
}
