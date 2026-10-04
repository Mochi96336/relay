/**
 * How much real time the phone's Mic capture has lost, judged from the phone's
 * own sample count.
 *
 * The phone numbers its Mic samples by what its capture actually produced
 * (`capturedSamples` in uplink health, `firstSampleIndex` on every packet).
 * When its audio graph loses render time - seen on 2026-10-03 as bursts of
 * about 220 ms adding up to 2-4% of real time - the numbering stays contiguous
 * while falling behind the wall clock. AudioSession anchors a capture once, so
 * to the mixer that looks exactly like audio arriving later and later, and
 * network lateness looks the same from the packets alone.
 *
 * The uplink health report tells them apart. It carries the capture's sample
 * count on the control path, so its arrival time minus the audio it reports
 * rises only when the capture itself falls behind: a late packet does not
 * change how many samples the phone has captured. Arrival jitter can only add
 * delay, so the least-delayed of the recent reports gives the capture's real
 * position, and the loss is how far that has risen above the least-delayed
 * report of the whole capture.
 *
 * Diagnostic evidence, and the confirmation AudioSession needs before it folds
 * a frontier correction into the Mic timeline. It owns no authority itself.
 */

export type MicCaptureDeliveryReport = {
  generation: number;
  capturedSamples: number;
  sampleRate: number;
  atMs: number;
};

export type MicCaptureDeliveryStatus = {
  generation: number;
  /** Real time the capture has lost since it began. Zero until it can be judged. */
  lossMs: number;
  /** Audio captured per unit of real time over the recent window; null until that is long enough. */
  ratio: number | null;
  /** What the ratio was measured over. */
  windowMs: number | null;
};

export type MicCaptureDeliveryMonitorOptions = {
  /** Reports skipped at capture start, while the phone's capture is still settling. */
  warmupReports?: number;
  /** Recent reports whose least-delayed one is taken as the capture's position. */
  envelopeReports?: number;
  ratioWindowMs?: number;
  minRatioWindowMs?: number;
};

type Point = { atMs: number; capturedSamples: number };

export class MicCaptureDeliveryMonitor {
  readonly warmupReports: number;
  readonly envelopeReports: number;
  readonly ratioWindowMs: number;
  readonly minRatioWindowMs: number;

  private generation: number | null = null;
  private sampleRate: number | null = null;
  private reportsSeen = 0;
  private lastCapturedSamples: number | null = null;
  private lowestOffsetMs: number | null = null;
  private readonly recentOffsetsMs: number[] = [];
  private readonly history: Point[] = [];

  constructor(options: MicCaptureDeliveryMonitorOptions = {}) {
    this.warmupReports = options.warmupReports ?? 1;
    this.envelopeReports = options.envelopeReports ?? 5;
    this.ratioWindowMs = options.ratioWindowMs ?? 30_000;
    this.minRatioWindowMs = options.minRatioWindowMs ?? 10_000;
    if (!Number.isInteger(this.warmupReports) || this.warmupReports < 0) {
      throw new RangeError('warmupReports must be a non-negative integer');
    }
    if (!Number.isInteger(this.envelopeReports) || this.envelopeReports < 1) {
      throw new RangeError('envelopeReports must be a positive integer');
    }
    if (!(this.minRatioWindowMs > 0) || !(this.ratioWindowMs >= this.minRatioWindowMs)) {
      throw new RangeError('ratio windows must be positive, the window no shorter than its minimum');
    }
  }

  observe(report: MicCaptureDeliveryReport) {
    if (
      !Number.isFinite(report.capturedSamples)
      || report.capturedSamples < 0
      || !(report.sampleRate > 0)
      || !Number.isFinite(report.atMs)
    ) return;
    if (report.generation !== this.generation || report.sampleRate !== this.sampleRate) {
      this.reset();
      this.generation = report.generation;
      this.sampleRate = report.sampleRate;
    }
    // Health for one capture never counts backwards; a report that does is
    // stale, and taking it would read as time the capture gained.
    if (this.lastCapturedSamples !== null && report.capturedSamples < this.lastCapturedSamples) return;
    this.lastCapturedSamples = report.capturedSamples;
    this.reportsSeen += 1;

    if (this.reportsSeen > this.warmupReports) {
      const offsetMs = report.atMs - (report.capturedSamples / report.sampleRate) * 1000;
      this.lowestOffsetMs = this.lowestOffsetMs === null
        ? offsetMs
        : Math.min(this.lowestOffsetMs, offsetMs);
      this.recentOffsetsMs.push(offsetMs);
      if (this.recentOffsetsMs.length > this.envelopeReports) this.recentOffsetsMs.shift();
    }

    this.history.push({ atMs: report.atMs, capturedSamples: report.capturedSamples });
    while (this.history.length > 2 && this.history[1]!.atMs <= report.atMs - this.ratioWindowMs) {
      this.history.shift();
    }
  }

  reset() {
    this.generation = null;
    this.sampleRate = null;
    this.reportsSeen = 0;
    this.lastCapturedSamples = null;
    this.lowestOffsetMs = null;
    this.recentOffsetsMs.length = 0;
    this.history.length = 0;
  }

  status(): MicCaptureDeliveryStatus | null {
    if (this.generation === null || this.sampleRate === null) return null;
    const lossMs = this.lowestOffsetMs === null || this.recentOffsetsMs.length < this.envelopeReports
      ? 0
      : Math.max(0, Math.min(...this.recentOffsetsMs) - this.lowestOffsetMs);

    const first = this.history[0];
    const last = this.history.at(-1);
    const windowMs = first && last ? last.atMs - first.atMs : 0;
    const ratio = first && last && windowMs >= this.minRatioWindowMs
      ? ((last.capturedSamples - first.capturedSamples) / this.sampleRate) / (windowMs / 1000)
      : null;
    return {
      generation: this.generation,
      lossMs: Math.round(lossMs),
      ratio: ratio === null ? null : Math.round(ratio * 10_000) / 10_000,
      windowMs: ratio === null ? null : Math.round(windowMs),
    };
  }
}
