/**
 * The Mic capture clock is a phone's, and it drifts against the mix clock
 * too: tens of ppm is ordinary. Mic packets are placed by their capture index
 * against an anchor taken once, so the drift accumulates for as long as the
 * capture lasts - a slow clock spends the live headroom (and moves the voice
 * earlier against the song), a fast one moves the voice later. At 50 ppm that
 * is 180 ms an hour. The estimate comes from arrival times
 * (MicClockDriftEstimator) and is applied as the same one-sample stretch the
 * Backing correction uses, or its mirror, at contiguous packet boundaries.
 *
 * The estimator reads a stable clock within about 15 ppm, so smaller estimates
 * are left alone rather than risk making a good clock worse; far larger ones
 * are not a capture clock.
 */
const MIC_CLOCK_TRIM_MIN_PPM = 15;
const MIC_CLOCK_TRIM_MAX_PPM = 500;

/** How far the Mic timeline is being trimmed for its capture clock, and what is owed. */
export class MicClockTrim {
  /** Mic capture clock error the timeline is being trimmed for; positive is slow. */
  private ppmValue = 0;
  /** Fractional samples of trim owed but not yet applied. */
  private carrySamples = 0;
  /** Net samples the trim has inserted (positive) or removed for this capture. */
  private trimmedSamples = 0;

  constructor(private readonly sampleRate: number) {}

  /** Capture clock error the Mic timeline is currently trimmed for, in ppm. */
  get ppm() {
    return this.ppmValue;
  }

  /** Net samples inserted (positive) or removed by the trim for this capture. */
  get samples() {
    return this.trimmedSamples;
  }

  /**
   * Trims for a capture clock running `ppm` slow (positive) or fast
   * (negative) against the mix clock. Null, or an estimate inside the
   * estimator's own error, stops trimming.
   */
  setPpm(ppm: number | null) {
    this.ppmValue = ppm !== null
      && Number.isFinite(ppm)
      && Math.abs(ppm) >= MIC_CLOCK_TRIM_MIN_PPM
      ? Math.max(-MIC_CLOCK_TRIM_MAX_PPM, Math.min(MIC_CLOCK_TRIM_MAX_PPM, ppm))
      : 0;
  }

  /** A new capture has its own clock and must be measured again. */
  reset() {
    this.ppmValue = 0;
    this.carrySamples = 0;
    this.trimmedSamples = 0;
  }

  /**
   * Accrues the trim owed for `sourceAdvance` source samples and decides what
   * this packet takes: 1 stretches it by a sample, -1 shortens it, 0 leaves it.
   * Owed trim follows the capture clock, holes included: the clock drifts
   * across a lost packet just the same. Only a packet that continues the
   * timeline exactly can take it; report what it took with applied().
   */
  next(sourceAdvance: number, sourceRate: number, contiguous: boolean, packetSamples: number) {
    if (sourceAdvance > 0) {
      this.carrySamples += (
        ((sourceAdvance * this.sampleRate) / sourceRate) * this.ppmValue
      ) / 1e6;
    }
    return !contiguous
      ? 0
      : this.carrySamples >= 1 && packetSamples >= 1
        ? 1
        : this.carrySamples <= -1 && packetSamples >= 3
          ? -1
          : 0;
  }

  applied(trim: number) {
    this.carrySamples -= trim;
    this.trimmedSamples += trim;
  }
}
