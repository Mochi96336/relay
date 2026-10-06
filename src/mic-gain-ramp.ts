/**
 * Perceptual (dB-domain) Mic gain ramp. Commands expose their target immediately;
 * samples and the look-ahead detector follow the same audible trajectory.
 */
const MIC_GAIN_RAMP_MS = 20;

export class MicGainRamp {
  private targetDbValue: number;
  private appliedDb: number;
  private remainingSamples = 0;
  private readonly rampSamples: number;

  constructor(sampleRate: number, initialDb = 24) {
    this.targetDbValue = initialDb;
    this.appliedDb = initialDb;
    this.rampSamples = Math.max(1, Math.round((MIC_GAIN_RAMP_MS / 1000) * sampleRate));
  }

  get targetDb() {
    return this.targetDbValue;
  }

  setTargetDb(value: number, running: boolean) {
    const changed = value !== this.targetDbValue;
    this.targetDbValue = value;
    if (!running) {
      this.reset();
    } else if (changed) {
      // A later command bends from the currently audible gain, not either target.
      this.remainingSamples = this.rampSamples;
    }
  }

  /** A new mix epoch begins at the current target. */
  reset() {
    this.appliedDb = this.targetDbValue;
    this.remainingSamples = 0;
  }

  advanceDb() {
    if (this.remainingSamples <= 0) {
      this.appliedDb = this.targetDbValue;
      return this.appliedDb;
    }
    this.appliedDb += (this.targetDbValue - this.appliedDb) / this.remainingSamples;
    this.remainingSamples -= 1;
    if (this.remainingSamples === 0) this.appliedDb = this.targetDbValue;
    return this.appliedDb;
  }

  /** Read a future gain without advancing the audible ramp. */
  projectDb(samplesAhead: number) {
    if (this.remainingSamples <= 0) return this.targetDbValue;
    const steps = Math.min(this.remainingSamples, Math.max(0, Math.round(samplesAhead)));
    return this.appliedDb + (this.targetDbValue - this.appliedDb) * (steps / this.remainingSamples);
  }
}
