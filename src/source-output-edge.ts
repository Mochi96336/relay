/**
 * The audible edges of one source (the Mic or the Backing) at the mix output.
 *
 * Source history stays exact; these edges only shape what the mix emits when a
 * source changes meaning or goes missing, over the same short de-click span:
 *
 * - A **replacement** (a retired capture, a capture-clock restart, a read head
 *   that jumped where it could not crossfade) converges from the contribution
 *   that was last heard, then fades the replacement in from silence.
 * - A **missing** source (a positioned hole, frontier starvation, structural
 *   pre-roll) fades from what was last heard to silence, and recovers from what
 *   was actually emitted when real audio returns.
 *
 * AudioSession owns one of these per source. Both sources used to carry their
 * own hand-kept copy of every field and method.
 */
export class SourceOutputEdge {
  /** Last contribution of this source that actually reached the mix output. */
  lastEmitted = 0;

  private retirementFadeStart = 0;
  private retirementFadeRemaining = 0;
  /** The replacement's first audible contribution must enter from silence. */
  private replacementNeedsFadeIn = false;
  private replacementFadeInRemaining = 0;
  private outputMissing = false;
  private missingFadeStart = 0;
  private missingFadeRemaining = 0;
  private recoveryFadeRemaining = 0;

  constructor(private readonly fadeSamples: number) {}

  reset() {
    this.lastEmitted = 0;
    this.retirementFadeStart = 0;
    this.retirementFadeRemaining = 0;
    this.replacementNeedsFadeIn = false;
    this.replacementFadeInRemaining = 0;
    this.resetMissingEdge();
  }

  /**
   * The source now means something else: converge from what was heard, then
   * let the replacement's first audible sample enter from silence.
   */
  beginReplacement() {
    this.beginConvergence();
    this.replacementNeedsFadeIn = true;
    this.replacementFadeInRemaining = 0;
  }

  /**
   * Converge from what was last heard to whatever the source reads next, over
   * one edge, without a fade-in: a jump that replays nothing.
   */
  beginConvergence() {
    this.retirementFadeStart = this.lastEmitted;
    this.retirementFadeRemaining = this.fadeSamples;
  }

  /** A replacement edge still owns this source's output. */
  get replacementActive() {
    return this.retirementFadeRemaining > 0
      || this.replacementNeedsFadeIn
      || this.replacementFadeInRemaining > 0;
  }

  /** The source is missing and its output has already faded to silence. */
  get silenced() {
    return this.outputMissing && this.missingFadeRemaining <= 0;
  }

  /**
   * One sample of this source, through its edges; also what it records as
   * last emitted.
   *
   * `evidenceMissing` is proven source failure - a gap or frontier miss - which
   * is a new edge and takes over from a replacement. `audibleMissing` is any
   * sample that is silent at the output, structural pre-roll included: that is
   * not source failure, so an active replacement keeps ownership through it.
   */
  apply(current: number, evidenceMissing: boolean, audibleMissing: boolean) {
    if (evidenceMissing && this.replacementActive) this.cancelReplacement();

    let value: number;
    if (this.retirementFadeRemaining > 0) {
      const replacementAudible = current !== 0;
      value = this.applyRetirementFade(current);
      if (replacementAudible) {
        this.replacementNeedsFadeIn = false;
        this.replacementFadeInRemaining = 0;
      }
    } else {
      value = this.applyReplacementFadeIn(current);
    }

    if (this.replacementActive) {
      // The replacement owns this boundary. Do not stack a missing-source taper
      // on top of it because the same sample also reads as missing.
      this.resetMissingEdge();
    } else {
      value = this.applyMissingEdge(value, audibleMissing);
    }
    this.lastEmitted = value;
    return value;
  }

  private cancelReplacement() {
    this.retirementFadeRemaining = 0;
    this.replacementNeedsFadeIn = false;
    this.replacementFadeInRemaining = 0;
  }

  private resetMissingEdge() {
    this.outputMissing = false;
    this.missingFadeStart = 0;
    this.missingFadeRemaining = 0;
    this.recoveryFadeRemaining = 0;
  }

  /** Weight of the target side at `progress` samples into a fade. */
  private fadeWeight(progress: number) {
    return this.fadeSamples <= 1 ? 1 : progress / (this.fadeSamples - 1);
  }

  private applyRetirementFade(current: number) {
    const remaining = this.retirementFadeRemaining;
    // The first sample continues the exact last audible contribution. After
    // that, converge from what was actually emitted toward the target that
    // exists now: a second restart can replace the target mid-transition, and
    // a fixed curve toward the original target would jump to it.
    const progress = this.fadeSamples - remaining;
    const value = progress === 0
      ? this.retirementFadeStart
      : this.lastEmitted + (current - this.lastEmitted) / remaining;
    this.retirementFadeRemaining -= 1;
    return value;
  }

  private applyReplacementFadeIn(current: number) {
    if (this.replacementFadeInRemaining <= 0) {
      if (!this.replacementNeedsFadeIn || current === 0) return current;
      this.replacementNeedsFadeIn = false;
      this.replacementFadeInRemaining = this.fadeSamples;
    }
    const progress = this.fadeSamples - this.replacementFadeInRemaining;
    const weight = this.fadeSamples <= 1 ? 0 : progress / (this.fadeSamples - 1);
    this.replacementFadeInRemaining -= 1;
    return current * weight;
  }

  /**
   * De-clicks the emitted boundaries around any proven missing source span,
   * whether frontier starvation or a positioned hole discovered only after the
   * audio before it was emitted. Raw timeline positions and evidence are
   * untouched.
   */
  private applyMissingEdge(current: number, sourceMissing: boolean) {
    if (sourceMissing) {
      if (!this.outputMissing) {
        this.outputMissing = true;
        this.missingFadeStart = this.lastEmitted;
        this.missingFadeRemaining = this.fadeSamples;
        this.recoveryFadeRemaining = 0;
      }
      // A missing source contributes only the fade of what was last heard. It
      // is not always read as zero: a read-rate slew interpolates the samples
      // around a hole's edge from both sides, so they are marked missing yet
      // carry part of the real audio. Fading toward that, or passing it
      // through once faded, left the recovery fade starting from it rather
      // than from silence.
      if (this.missingFadeRemaining <= 0) return 0;
      const value = this.missingFadeStart
        * (1 - this.fadeWeight(this.fadeSamples - this.missingFadeRemaining));
      this.missingFadeRemaining -= 1;
      return value;
    }

    if (this.outputMissing) {
      // A very short hole can end before the fade-out has reached silence.
      // Recovery continues from the contribution that was actually emitted,
      // not from an assumed zero baseline.
      if (current === 0) {
        if (this.missingFadeRemaining <= 0) return current;
        const value = this.missingFadeStart
          * (1 - this.fadeWeight(this.fadeSamples - this.missingFadeRemaining));
        this.missingFadeRemaining -= 1;
        return value;
      }
      this.outputMissing = false;
      this.missingFadeRemaining = 0;
      // Recovery crossfades from one fixed audible starting point. Chasing a
      // moving waveform from the last emitted sample on every step leaves a
      // residual error that the final step exposes as a one-sample snap.
      this.missingFadeStart = this.lastEmitted;
      this.recoveryFadeRemaining = this.fadeSamples;
    }
    const remaining = this.recoveryFadeRemaining;
    if (remaining <= 0) return current;
    const weight = this.fadeWeight(this.fadeSamples - remaining);
    this.recoveryFadeRemaining -= 1;
    return this.missingFadeStart * (1 - weight) + current * weight;
  }
}
