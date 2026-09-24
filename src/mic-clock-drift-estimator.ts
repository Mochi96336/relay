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
 */

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
  private readonly minima: WindowMinimum[] = [];

  constructor(options: MicClockDriftEstimatorOptions = {}) {
    this.windowMs = options.windowMs ?? 5_000;
    this.maxWindows = options.maxWindows ?? 24;
    this.minWindows = options.minWindows ?? 6;
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
    }

    // Arrival on the mix clock minus capture position on the source clock,
    // both in source samples. Only its change over time matters.
    const delaySamples = (arrivedAtMs * sourceRate) / 1000 - sourceEndSample;
    if (this.windowStartedAtMs === null) this.windowStartedAtMs = arrivedAtMs;
    this.windowMinimum = this.windowMinimum === null
      ? delaySamples
      : Math.min(this.windowMinimum, delaySamples);

    if (arrivedAtMs - this.windowStartedAtMs >= this.windowMs) {
      this.minima.push({ atMs: arrivedAtMs, delaySamples: this.windowMinimum });
      if (this.minima.length > this.maxWindows) this.minima.shift();
      this.windowStartedAtMs = arrivedAtMs;
      this.windowMinimum = null;
    }
  }

  estimate(): MicClockDriftEstimate | null {
    if (this.minima.length < this.minWindows || this.sourceRate === null) return null;
    const n = this.minima.length;
    const originMs = this.minima[0]!.atMs;
    let sumX = 0;
    let sumY = 0;
    for (const { atMs, delaySamples } of this.minima) {
      sumX += atMs - originMs;
      sumY += delaySamples;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let covariance = 0;
    let variance = 0;
    for (const { atMs, delaySamples } of this.minima) {
      const dx = atMs - originMs - meanX;
      covariance += dx * (delaySamples - meanY);
      variance += dx * dx;
    }
    if (variance === 0) return null;
    // Slope in source samples per millisecond; a growing delay means the
    // capture clock produces samples slower than real time.
    const slopeSamplesPerMs = covariance / variance;
    const ppm = (slopeSamplesPerMs * 1000 * 1e6) / this.sourceRate;
    return {
      ppm: Math.round(ppm * 10) / 10,
      windows: n,
      spanMs: Math.round(this.minima[n - 1]!.atMs - originMs),
    };
  }
}
