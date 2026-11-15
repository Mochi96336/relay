/**
 * Low cut on the microphone, applied as its PCM is placed on the timeline.
 *
 * Relay turns the browser's voice processing off so a singer is heard as sung,
 * and that also turns off the high-pass filter that processing would apply.
 * Nothing else stood between the capsule and the limiter. A headset boom sits
 * in the singer's breath: on 2026-11-12 one such capture carried 73% of its
 * energy below 20 Hz, and the limiter, which reacts to the whole band, spent
 * its headroom holding that inaudible pressure under the ceiling while the
 * voice sat 4 dB under the song.
 *
 * A second-order Butterworth high-pass at 80 Hz, the usual low cut on a vocal
 * channel: breath and handling thumps lose 24 dB or more at 20 Hz and below,
 * a sung E2 (82 Hz) about 3 dB, and everything from 160 Hz up keeps its level
 * within 0.3 dB. Group delay is about half a millisecond at 200 Hz and less
 * above, far inside any timing tolerance; the probe tones (1-1.6 kHz) are
 * untouched.
 *
 * Filtering at placement keeps one copy of the truth: the mixer, the limiter
 * detector, concealment and every calibration reader see the same samples.
 * Raw-input clipping detection still reads the packet as it arrived.
 */
export const MIC_LOW_CUT_HZ = 80;
const BUTTERWORTH_Q = Math.SQRT1_2;

export class MicLowCut {
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private z1 = 0;
  private z2 = 0;
  /** Whether the state continues the last sample this filter produced. */
  private primed = false;
  private enabledValue = true;

  constructor(sampleRate: number, cutoffHz = MIC_LOW_CUT_HZ) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      throw new RangeError('sampleRate must be positive');
    }
    if (!Number.isFinite(cutoffHz) || cutoffHz <= 0 || cutoffHz >= sampleRate / 2) {
      throw new RangeError('cutoffHz must be between 0 and Nyquist');
    }
    // RBJ cookbook high-pass, normalised by a0.
    const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * BUTTERWORTH_Q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }

  get enabled() {
    return this.enabledValue;
  }

  /**
   * A premixed capture already carries the song, whose bass is music, not
   * breath. The switch belongs to the capture; either way the next placed
   * PCM starts a fresh filter run.
   */
  setEnabled(enabled: boolean) {
    if (enabled === this.enabledValue) return;
    this.enabledValue = enabled;
    this.primed = false;
  }

  /**
   * Filters newly placed PCM in place.
   *
   * `continuous` says the samples directly follow the last ones this filter
   * produced, in the same capture. Anything else - a new capture, a transport
   * hole, PCM after a bypassed stretch - starts a fresh run, seeded as if its
   * first sample had always been there. That steady state outputs zero, so a
   * capture that begins on a DC offset fades from silence instead of stepping.
   */
  process(samples: Int16Array, continuous: boolean) {
    if (!this.enabledValue) {
      this.primed = false;
      return;
    }
    if (samples.length === 0) return;
    if (!continuous || !this.primed) {
      const first = samples[0];
      this.z1 = -this.b0 * first;
      this.z2 = this.b2 * first;
    }
    const { b0, b1, b2, a1, a2 } = this;
    let { z1, z2 } = this;
    for (let i = 0; i < samples.length; i += 1) {
      const x = samples[i];
      const y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      // Removing an offset can only lower a peak, but ringing on a flat-topped
      // input can overshoot it; Int16 storage bounds that.
      samples[i] = y >= 32767 ? 32767 : y <= -32768 ? -32768 : Math.round(y);
    }
    this.z1 = z1;
    this.z2 = z2;
    this.primed = true;
  }
}
