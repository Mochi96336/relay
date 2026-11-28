/**
 * ITU-R BS.1770 loudness of one channel, in LUFS.
 *
 * Peak level says what a limiter will do; it does not say how loud a voice
 * sounds beside a song. A mastered backing track and a sung voice can share a
 * peak and sit 10 dB apart in loudness, so a balance between the two has to be
 * measured the way BS.1770 does: K-weighted (a high shelf for the head, a high
 * pass for the ear's low-frequency deafness), mean square over 100 ms blocks,
 * read as momentary (400 ms), short-term (3 s) and gated integrated loudness.
 *
 * Shared by the Relay's mixer and phone-side mixing so both judge a balance
 * on the same scale. Plain arithmetic, one push per sample, no allocation on
 * the sample path.
 */

export const LUFS_SILENCE = -Infinity;
const BLOCK_MS = 100;
const MOMENTARY_BLOCKS = 4;
const SHORT_TERM_BLOCKS = 30;
const ABSOLUTE_GATE_LUFS = -70;
const RELATIVE_GATE_LU = 10;

/** BS.1770-4 Table 1/2 coefficients, exact at 48 kHz. */
const K_WEIGHTING_48K = Object.freeze({
  shelf: { b: [1.53512485958697, -2.69169618940638, 1.19839281085285], a: [-1.69065929318241, 0.73248077421585] },
  highPass: { b: [1, -2, 1], a: [-1.99004745483398, 0.99007225036621] },
});

/**
 * The same two filters at any rate, from the analog prototypes the 48 kHz
 * table was derived from. A phone's context can run at 44.1 kHz.
 */
export function kWeightingCoefficients(sampleRate) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('Invalid loudness sample rate.');
  if (sampleRate === 48_000) return K_WEIGHTING_48K;

  // libebur128's derivation: the bilinear transform of the analog shelf and
  // high pass, prewarped at their corner frequencies. At 48 kHz it reproduces
  // the BS.1770 table to about 1e-8.
  let k = Math.tan((Math.PI * 1681.974450955533) / sampleRate);
  let q = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20);
  const vb = vh ** 0.4996667741545416;
  let a0 = 1 + k / q + k * k;
  const shelf = {
    b: [(vh + (vb * k) / q + k * k) / a0, (2 * (k * k - vh)) / a0, (vh - (vb * k) / q + k * k) / a0],
    a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0],
  };
  k = Math.tan((Math.PI * 38.13547087602444) / sampleRate);
  q = 0.5003270373238773;
  a0 = 1 + k / q + k * k;
  // The table normalizes this stage's numerator to [1, -2, 1].
  const highPass = { b: [1, -2, 1], a: [(2 * (k * k - 1)) / a0, (1 - k / q + k * k) / a0] };
  return Object.freeze({ shelf, highPass });
}

/**
 * Below this a mean square is the K-weighting filters' decaying tail, not
 * audio: they never reach exactly zero after a source stops, and read as
 * thousands of dB down. -150 LUFS is far below anything 16-bit PCM can carry.
 */
const SILENT_MEAN_SQUARE = 10 ** ((-150 + 0.691) / 10);

/** Mean square to LUFS for one channel; silence is -Infinity, never NaN. */
export function lufsFromMeanSquare(meanSquare) {
  return meanSquare > SILENT_MEAN_SQUARE ? -0.691 + 10 * Math.log10(meanSquare) : LUFS_SILENCE;
}

export class LoudnessMeter {
  #s1b0; #s1b1; #s1b2; #s1a1; #s1a2;
  #s2b0; #s2b1; #s2b2; #s2a1; #s2a2;
  // Stage 1 (shelf) input/output history, then stage 2 (high pass).
  #x1 = 0; #x2 = 0; #y1 = 0; #y2 = 0;
  #z1 = 0; #z2 = 0; #kz1 = 0; #kz2 = 0;
  #blockSamples;
  #blockFill = 0;
  #blockSum = 0;
  /** Mean square of the last SHORT_TERM_BLOCKS completed 100 ms blocks, oldest overwritten. */
  #blocks = new Float64Array(SHORT_TERM_BLOCKS);
  #blockCount = 0;
  #blockIndex = 0;

  constructor(sampleRate = 48_000) {
    const { shelf, highPass } = kWeightingCoefficients(sampleRate);
    [this.#s1b0, this.#s1b1, this.#s1b2] = shelf.b;
    [this.#s1a1, this.#s1a2] = shelf.a;
    [this.#s2b0, this.#s2b1, this.#s2b2] = highPass.b;
    [this.#s2a1, this.#s2a2] = highPass.a;
    this.sampleRate = sampleRate;
    this.#blockSamples = Math.round((sampleRate * BLOCK_MS) / 1000);
  }

  /** One sample, full scale ±1. Returns true when it completed a 100 ms block. */
  push(x) {
    const y = this.#s1b0 * x + this.#s1b1 * this.#x1 + this.#s1b2 * this.#x2
      - this.#s1a1 * this.#y1 - this.#s1a2 * this.#y2;
    this.#x2 = this.#x1; this.#x1 = x;
    this.#y2 = this.#y1; this.#y1 = y;
    const k = this.#s2b0 * y + this.#s2b1 * this.#z1 + this.#s2b2 * this.#z2
      - this.#s2a1 * this.#kz1 - this.#s2a2 * this.#kz2;
    this.#z2 = this.#z1; this.#z1 = y;
    this.#kz2 = this.#kz1; this.#kz1 = k;
    this.#blockSum += k * k;
    this.#blockFill += 1;
    if (this.#blockFill < this.#blockSamples) return false;
    this.#blocks[this.#blockIndex] = this.#blockSum / this.#blockFill;
    this.#blockIndex = (this.#blockIndex + 1) % SHORT_TERM_BLOCKS;
    this.#blockCount = Math.min(SHORT_TERM_BLOCKS, this.#blockCount + 1);
    this.#blockSum = 0;
    this.#blockFill = 0;
    return true;
  }

  #meanOfLast(count) {
    if (this.#blockCount < count) return null;
    let sum = 0;
    for (let i = 1; i <= count; i += 1) {
      sum += this.#blocks[(this.#blockIndex - i + SHORT_TERM_BLOCKS) % SHORT_TERM_BLOCKS];
    }
    return sum / count;
  }

  /** 400 ms loudness, null until 400 ms have been measured. */
  get momentaryLufs() {
    const meanSquare = this.#meanOfLast(MOMENTARY_BLOCKS);
    return meanSquare === null ? null : lufsFromMeanSquare(meanSquare);
  }

  /** 3 s loudness, null until 3 s have been measured. */
  get shortTermLufs() {
    const meanSquare = this.#meanOfLast(SHORT_TERM_BLOCKS);
    return meanSquare === null ? null : lufsFromMeanSquare(meanSquare);
  }

  /** Mean square of the last 400 ms, for a caller that gates its own blocks. */
  get momentaryMeanSquare() {
    return this.#meanOfLast(MOMENTARY_BLOCKS);
  }

  /** Forget filter state and history: a new source, not a continuation. */
  reset() {
    this.#x1 = 0; this.#x2 = 0; this.#y1 = 0; this.#y2 = 0;
    this.#z1 = 0; this.#z2 = 0; this.#kz1 = 0; this.#kz2 = 0;
    this.#blockFill = 0; this.#blockSum = 0;
    this.#blocks.fill(0); this.#blockCount = 0; this.#blockIndex = 0;
  }
}

/**
 * BS.1770 gated integrated loudness over 400 ms blocks with a 100 ms hop:
 * blocks under -70 LUFS are dropped, then blocks more than 10 LU under the
 * mean of the rest. Feed it `momentaryMeanSquare` each time a meter completes
 * a block.
 */
export class IntegratedLoudness {
  #blocks = [];

  add(meanSquare) {
    if (meanSquare !== null && Number.isFinite(meanSquare)) this.#blocks.push(meanSquare);
  }

  get blockCount() {
    return this.#blocks.length;
  }

  get lufs() {
    const absolute = this.#blocks.filter((ms) => lufsFromMeanSquare(ms) > ABSOLUTE_GATE_LUFS);
    if (absolute.length === 0) return null;
    const relativeGate = lufsFromMeanSquare(mean(absolute)) - RELATIVE_GATE_LU;
    const gated = absolute.filter((ms) => lufsFromMeanSquare(ms) > relativeGate);
    return gated.length === 0 ? null : lufsFromMeanSquare(mean(gated));
  }
}

function mean(values) {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}
