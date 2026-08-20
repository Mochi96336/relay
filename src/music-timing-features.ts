export type MusicTimingFeatures = {
  hopSamples: number;
  hopMs: number;
  frameCount: number;
  bandCount: number;
  /** Channel-major: E0..E6, F0..F6. */
  values: Float64Array;
  /** Backing-side reliability evidence for B0..B6. */
  bandActivity: Float64Array;
};

export const MUSIC_TIMING_BANDS_HZ = [
  [120, 250],
  [250, 500],
  [500, 1_000],
  [1_000, 2_000],
  [2_000, 4_000],
  [4_000, 6_000],
  [6_000, 9_000],
] as const;

const FFT_SIZE = 1_024;
const HOP_MS = 5;
const LOCAL_MEAN_RADIUS_MS = 125;
const LOG_EPSILON = 1e-12;
const ROBUST_CLIP = 3;

function median(values: ArrayLike<number>) {
  if (values.length === 0) return 0;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function robustNormalize(values: Float64Array) {
  const center = median(values);
  const deviations = new Float64Array(values.length);
  let sumSquares = 0;

  for (let i = 0; i < values.length; i += 1) {
    const delta = values[i] - center;
    deviations[i] = Math.abs(delta);
    sumSquares += delta * delta;
  }

  const madScale = median(deviations) * 1.4826;
  const rmsScale = Math.sqrt(sumSquares / Math.max(1, values.length));
  const scale = madScale > 1e-6 ? madScale : rmsScale > 1e-6 ? rmsScale : 1;
  const normalized = new Float64Array(values.length);

  for (let i = 0; i < values.length; i += 1) {
    normalized[i] = Math.max(
      -ROBUST_CLIP,
      Math.min(ROBUST_CLIP, (values[i] - center) / scale),
    );
  }

  return normalized;
}

function fftInPlace(real: Float64Array, imag: Float64Array) {
  for (let i = 1, j = 0; i < FFT_SIZE; i += 1) {
    let bit = FFT_SIZE >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i >= j) continue;

    const realValue = real[i];
    real[i] = real[j];
    real[j] = realValue;
    const imagValue = imag[i];
    imag[i] = imag[j];
    imag[j] = imagValue;
  }

  for (let length = 2; length <= FFT_SIZE; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepCos = Math.cos(angle);
    const stepSin = Math.sin(angle);

    for (let start = 0; start < FFT_SIZE; start += length) {
      let twiddleCos = 1;
      let twiddleSin = 0;
      const half = length >> 1;

      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = real[odd] * twiddleCos - imag[odd] * twiddleSin;
        const oddImag = real[odd] * twiddleSin + imag[odd] * twiddleCos;
        const evenReal = real[even];
        const evenImag = imag[even];

        real[even] = evenReal + oddReal;
        imag[even] = evenImag + oddImag;
        real[odd] = evenReal - oddReal;
        imag[odd] = evenImag - oddImag;

        const nextCos = twiddleCos * stepCos - twiddleSin * stepSin;
        twiddleSin = twiddleCos * stepSin + twiddleSin * stepCos;
        twiddleCos = nextCos;
      }
    }
  }
}

export function extractMusicTimingFeatures(
  samples: Int16Array,
  sampleRate: number,
): MusicTimingFeatures {
  if (sampleRate <= 0) throw new Error('Invalid music timing feature sample rate.');

  const hopSamples = Math.max(1, Math.round((sampleRate * HOP_MS) / 1_000));
  const hopMs = (hopSamples * 1_000) / sampleRate;
  const frameCount = samples.length < FFT_SIZE
    ? 0
    : Math.floor((samples.length - FFT_SIZE) / hopSamples) + 1;
  const bandCount = MUSIC_TIMING_BANDS_HZ.length;
  const logBands = Array.from({ length: bandCount }, () => new Float64Array(frameCount));
  const meanPower = new Float64Array(bandCount);

  const hann = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  }

  const binHz = sampleRate / FFT_SIZE;
  const binRanges = MUSIC_TIMING_BANDS_HZ.map(([lowHz, highHz]) => ({
    from: Math.max(1, Math.ceil(lowHz / binHz)),
    to: Math.min(FFT_SIZE >> 1, Math.ceil(highHz / binHz) - 1),
  }));
  const real = new Float64Array(FFT_SIZE);
  const imag = new Float64Array(FFT_SIZE);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hopSamples;
    let mean = 0;
    for (let i = 0; i < FFT_SIZE; i += 1) mean += samples[start + i] / 32768;
    mean /= FFT_SIZE;

    for (let i = 0; i < FFT_SIZE; i += 1) {
      real[i] = ((samples[start + i] / 32768) - mean) * hann[i];
      imag[i] = 0;
    }
    fftInPlace(real, imag);

    for (let band = 0; band < bandCount; band += 1) {
      const { from, to } = binRanges[band];
      let power = 0;
      let bins = 0;
      for (let bin = from; bin <= to; bin += 1) {
        power += real[bin] * real[bin] + imag[bin] * imag[bin];
        bins += 1;
      }

      const averagePower = power / Math.max(1, bins);
      meanPower[band] += averagePower;
      logBands[band][frame] = Math.log(averagePower + LOG_EPSILON);
    }
  }

  const radius = Math.max(1, Math.round(LOCAL_MEAN_RADIUS_MS / hopMs));
  const contrastBands = Array.from({ length: bandCount }, () => new Float64Array(frameCount));
  const fluxBands = Array.from({ length: bandCount }, () => new Float64Array(frameCount));
  const bandActivity = new Float64Array(bandCount);

  for (let band = 0; band < bandCount; band += 1) {
    const prefix = new Float64Array(frameCount + 1);
    for (let frame = 0; frame < frameCount; frame += 1) {
      prefix[frame + 1] = prefix[frame] + logBands[band][frame];
    }

    let contrastSquares = 0;
    let positiveFlux = 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const from = Math.max(0, frame - radius);
      const to = Math.min(frameCount, frame + radius + 1);
      const localMean = (prefix[to] - prefix[from]) / Math.max(1, to - from);
      const contrast = logBands[band][frame] - localMean;
      const flux = frame === 0
        ? 0
        : Math.max(0, logBands[band][frame] - logBands[band][frame - 1]);

      contrastBands[band][frame] = contrast;
      fluxBands[band][frame] = flux;
      contrastSquares += contrast * contrast;
      positiveFlux += flux;
    }

    bandActivity[band] = Math.sqrt(contrastSquares / Math.max(1, frameCount))
      + positiveFlux / Math.max(1, frameCount);
  }

  let strongestMeanPower = 0;
  for (let band = 0; band < bandCount; band += 1) {
    meanPower[band] /= Math.max(1, frameCount);
    strongestMeanPower = Math.max(strongestMeanPower, meanPower[band]);
  }
  if (strongestMeanPower > 0) {
    for (let band = 0; band < bandCount; band += 1) {
      // A transient has some FFT leakage everywhere. Weight temporal evidence by
      // how much backing energy really lives in this band so leakage cannot make
      // one low-frequency pulse look like seven independent witnesses.
      bandActivity[band] *= Math.sqrt(meanPower[band] / strongestMeanPower);
    }
  }

  const values = new Float64Array(frameCount * bandCount * 2);
  for (let band = 0; band < bandCount; band += 1) {
    values.set(robustNormalize(contrastBands[band]), band * frameCount);
    values.set(robustNormalize(fluxBands[band]), (bandCount + band) * frameCount);
  }

  return {
    hopSamples,
    hopMs,
    frameCount,
    bandCount,
    values,
    bandActivity,
  };
}
