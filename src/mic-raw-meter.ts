/**
 * Raw Mic evidence from accepted input PCM, before gain or limiting. Capture
 * replacement resets this history immediately, even while old output is queued.
 */
const MIC_METER_HALF_LIFE_MS = 2_000;

export class MicRawMeter {
  private peak = 0;
  private power = 0;
  private weight = 0;

  constructor(private readonly sampleRate: number) {}

  get peakDbfs() {
    return this.peak > 0 ? 20 * Math.log10(this.peak) : null;
  }

  get rmsDbfs() {
    return this.weight > 0 && this.power > 0
      ? 20 * Math.log10(Math.sqrt(this.power / this.weight))
      : null;
  }

  reset() {
    this.peak = 0;
    this.power = 0;
    this.weight = 0;
  }

  observe(samples: Int16Array) {
    if (samples.length === 0) return;
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] / 32768;
      sumSquares += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
    }

    // Decay follows the batch's audio duration, not the transport packet count.
    const keep = 2 ** (-((samples.length / this.sampleRate) * 1000) / MIC_METER_HALF_LIFE_MS);
    this.peak = Math.max(peak, this.peak * keep);
    this.power = sumSquares / samples.length + this.power * keep;
    this.weight = 1 + this.weight * keep;
  }
}
