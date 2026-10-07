/**
 * Peak limiter on the microphone, between its gain and the sum.
 *
 * One static gain cannot serve both ends of a voice: peaks run some 16 dB above
 * the average, so a gain set loud enough to hear clips on transients and a gain
 * set safe enough to never clip is inaudible. Every decibel between those is
 * the whole tuning range, and it moves whenever the singer does.
 *
 * A textbook feed-forward design: track the peak envelope, pull the gain down
 * quickly when it exceeds the threshold, let it back up slowly.
 *
 * The detector runs `LIMITER_LOOKAHEAD_MS` in front of the output, which is
 * normally bought by delaying the signal. Here it is free: the microphone is
 * read out of a buffer by index, so the limiter can simply look at samples the
 * mixer has not emitted yet. Nothing is delayed, so none of this moves the
 * alignment. Without it the first few milliseconds of every transient reach
 * the sum at full height before the envelope catches up.
 *
 * The final two-source sum also reserves fixed headroom. That keeps ordinary
 * voice + song peaks out of the hard clamp without adding a second dynamic
 * limiter that would pump the whole mix and change the singer/song balance.
 */
export const LIMITER_THRESHOLD_DBFS = -1;
const LIMITER_THRESHOLD = 10 ** (LIMITER_THRESHOLD_DBFS / 20);
// Five attack time constants fit in the look-ahead, so the gain has reached
// within 1% of its target when the detected peak arrives. At 1.5 ms only two
// fitted: a plosive after quiet singing kept about 14% of the reduction still
// to come, which at the default gain is about a third above the threshold and past
// the clamp. Still a millisecond-scale ramp, so the reduction does not click.
const LIMITER_ATTACK_MS = 0.6;
const LIMITER_RELEASE_MS = 150;
const LIMITER_LOOKAHEAD_MS = 3;
/**
 * Gain reduction past which limiting is audible rather than protective. The
 * attack is sub-millisecond, so a dB or two on transients goes unheard; held
 * reduction past this is what makes a hot vocal sound squashed.
 */
export const HEAVY_LIMIT_DB = 3;
const HEAVY_LIMIT_GAIN = 10 ** (-HEAVY_LIMIT_DB / 20);

/** Per-sample coefficient of a one-pole smoother with the given time constant. */
function onePoleCoefficient(timeConstantMs: number, sampleRate: number) {
  return 1 - Math.exp(-1 / ((timeConstantMs / 1000) * sampleRate));
}

/**
 * Capture-scoped peak dynamics. The timeline owner supplies the detector
 * sample, decides when a capture becomes audible, and counts emitted evidence.
 */
export class MicLimiter {
  readonly ceiling = LIMITER_THRESHOLD;
  readonly lookaheadSamples: number;
  private readonly attack: number;
  private readonly release: number;
  private envelope = 0;
  private gain = 1;

  constructor(sampleRate: number) {
    this.attack = onePoleCoefficient(LIMITER_ATTACK_MS, sampleRate);
    this.release = onePoleCoefficient(LIMITER_RELEASE_MS, sampleRate);
    this.lookaheadSamples = Math.round((LIMITER_LOOKAHEAD_MS * sampleRate) / 1000);
  }

  get limiting() {
    return this.gain < 0.99;
  }

  get heavilyLimiting() {
    return this.gain < HEAVY_LIMIT_GAIN;
  }

  /** New capture/epoch dynamics; cumulative frame evidence belongs to the caller. */
  reset() {
    this.envelope = 0;
    this.gain = 1;
  }

  /** Seed a semantic edge from the first audible capture's own future peak. */
  seedPeak(peak: number) {
    this.envelope = peak;
    this.gain = peak > LIMITER_THRESHOLD ? LIMITER_THRESHOLD / peak : 1;
  }

  /**
   * The detector runs a few milliseconds ahead of value, so reduction has
   * engaged when the detected peak reaches the output.
   */
  apply(value: number, detect: number) {
    const magnitude = Math.abs(detect);
    // Peak-hold has no attack lag; only the applied gain ramps on attack.
    this.envelope = magnitude > this.envelope
      ? magnitude
      : this.envelope + (magnitude - this.envelope) * this.release;
    const target = this.envelope > LIMITER_THRESHOLD
      ? LIMITER_THRESHOLD / this.envelope
      : 1;
    this.gain += (target - this.gain)
      * (target < this.gain ? this.attack : this.release);
    return value * this.gain;
  }
}
