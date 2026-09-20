const SPECTRUM_FFT_SIZE = 512;
const SPECTRUM_DYNAMIC_RANGE_DB = 24;
const SPECTRUM_BANDS_HZ = [
  [80, 250],
  [250, 500],
  [500, 1000],
  [1000, 2000],
  [2000, 4000],
];
const F0_MIN_HZ = 80;
const F0_MAX_HZ = 1000;
const F0_DOWNSAMPLE_TARGET_HZ = 12_000;
const F0_RING_SIZE = 1024;
const F0_YIN_THRESHOLD = 0.18;
const F0_MIN_CONFIDENCE = 0.6;
const F0_ANALYSIS_CHUNKS = 2;
const F0_SILENCE_RMS = 1e-4;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

let configuredSampleRate = 48_000;
let spectrumRing;
let spectrumWrite;
let spectrumSamples;
let fftReal;
let fftImag;
let fftWindow;
let f0DownsampleFactor;
let f0SampleRate;
let f0Ring;
let f0Write;
let f0Samples;
let f0DecimationSum;
let f0DecimationCount;
let f0Scratch;
let f0Cmnd;
let f0ChunksSinceEstimate;
let f0Hz;
let pitchConfidence;

function reset(sampleRate) {
  configuredSampleRate = Number.isFinite(sampleRate) && sampleRate >= 8_000 && sampleRate <= 192_000
    ? sampleRate
    : 48_000;

  spectrumRing = new Float32Array(SPECTRUM_FFT_SIZE);
  spectrumWrite = 0;
  spectrumSamples = 0;
  fftReal = new Float32Array(SPECTRUM_FFT_SIZE);
  fftImag = new Float32Array(SPECTRUM_FFT_SIZE);
  fftWindow = new Float32Array(SPECTRUM_FFT_SIZE);
  for (let i = 0; i < SPECTRUM_FFT_SIZE; i += 1) {
    fftWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPECTRUM_FFT_SIZE - 1));
  }

  f0DownsampleFactor = Math.max(
    1,
    Math.round(configuredSampleRate / F0_DOWNSAMPLE_TARGET_HZ),
  );
  f0SampleRate = configuredSampleRate / f0DownsampleFactor;
  f0Ring = new Float32Array(F0_RING_SIZE);
  f0Write = 0;
  f0Samples = 0;
  f0DecimationSum = 0;
  f0DecimationCount = 0;
  f0Scratch = new Float32Array(F0_RING_SIZE);
  f0Cmnd = new Float32Array(Math.ceil(f0SampleRate / F0_MIN_HZ) + 2);
  f0ChunksSinceEstimate = 0;
  f0Hz = null;
  pitchConfidence = 0;
}

function pushSpectrumSample(sample) {
  spectrumRing[spectrumWrite] = sample;
  spectrumWrite = (spectrumWrite + 1) % SPECTRUM_FFT_SIZE;
  spectrumSamples = Math.min(SPECTRUM_FFT_SIZE, spectrumSamples + 1);
}

function pushF0Sample(sample) {
  f0DecimationSum += sample;
  f0DecimationCount += 1;
  if (f0DecimationCount < f0DownsampleFactor) return;

  f0Ring[f0Write] = f0DecimationSum / f0DecimationCount;
  f0Write = (f0Write + 1) % F0_RING_SIZE;
  f0Samples = Math.min(F0_RING_SIZE, f0Samples + 1);
  f0DecimationSum = 0;
  f0DecimationCount = 0;
}

function runFft() {
  const n = SPECTRUM_FFT_SIZE;
  const missing = n - spectrumSamples;

  for (let i = 0; i < n; i += 1) {
    let sample = 0;
    if (i >= missing) {
      const logical = i - missing;
      const oldest = spectrumSamples === n ? spectrumWrite : 0;
      const source = (oldest + logical) % n;
      sample = spectrumRing[source];
    }
    fftReal[i] = sample * fftWindow[i];
    fftImag[i] = 0;
  }

  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i >= j) continue;
    const real = fftReal[i];
    const imag = fftImag[i];
    fftReal[i] = fftReal[j];
    fftImag[i] = fftImag[j];
    fftReal[j] = real;
    fftImag[j] = imag;
  }

  for (let length = 2; length <= n; length <<= 1) {
    const half = length >> 1;
    const angle = (-2 * Math.PI) / length;
    const stepCos = Math.cos(angle);
    const stepSin = Math.sin(angle);

    for (let start = 0; start < n; start += length) {
      let wCos = 1;
      let wSin = 0;
      for (let offset = 0; offset < half; offset += 1) {
        const even = start + offset;
        const odd = even + half;
        const oddReal = fftReal[odd] * wCos - fftImag[odd] * wSin;
        const oddImag = fftReal[odd] * wSin + fftImag[odd] * wCos;
        const evenReal = fftReal[even];
        const evenImag = fftImag[even];

        fftReal[even] = evenReal + oddReal;
        fftImag[even] = evenImag + oddImag;
        fftReal[odd] = evenReal - oddReal;
        fftImag[odd] = evenImag - oddImag;

        const nextCos = wCos * stepCos - wSin * stepSin;
        wSin = wCos * stepSin + wSin * stepCos;
        wCos = nextCos;
      }
    }
  }
}

function measureSpectrumBands() {
  runFft();
  const bandDb = [];
  const binHz = configuredSampleRate / SPECTRUM_FFT_SIZE;

  for (const [lowHz, highHz] of SPECTRUM_BANDS_HZ) {
    const startBin = Math.max(1, Math.ceil(lowHz / binHz));
    const endBin = Math.min((SPECTRUM_FFT_SIZE >> 1) - 1, Math.floor(highHz / binHz));
    let power = 0;
    let count = 0;
    for (let bin = startBin; bin <= endBin; bin += 1) {
      const real = fftReal[bin];
      const imag = fftImag[bin];
      power += real * real + imag * imag;
      count += 1;
    }
    bandDb.push(10 * Math.log10((count > 0 ? power / count : 0) + 1e-12));
  }

  const strongest = Math.max(...bandDb);
  return bandDb.map((value) => {
    const relative = clamp(
      (value - (strongest - SPECTRUM_DYNAMIC_RANGE_DB)) / SPECTRUM_DYNAMIC_RANGE_DB,
      0,
      1,
    );
    return Math.pow(relative, 0.72);
  });
}

function measureF0(rms) {
  if (rms < F0_SILENCE_RMS) {
    f0ChunksSinceEstimate = 0;
    f0Hz = null;
    pitchConfidence = 0;
    return;
  }

  f0ChunksSinceEstimate += 1;
  if (f0ChunksSinceEstimate < F0_ANALYSIS_CHUNKS) return;
  f0ChunksSinceEstimate = 0;

  const count = Math.min(f0Samples, F0_RING_SIZE);
  const minLag = Math.max(2, Math.floor(f0SampleRate / F0_MAX_HZ));
  const maxLag = Math.min(f0Cmnd.length - 2, Math.ceil(f0SampleRate / F0_MIN_HZ));
  if (count < maxLag + minLag + 8) {
    f0Hz = null;
    pitchConfidence = 0;
    return;
  }

  const oldest = f0Samples === F0_RING_SIZE ? f0Write : 0;
  for (let i = 0; i < count; i += 1) {
    f0Scratch[i] = f0Ring[(oldest + i) % F0_RING_SIZE];
  }

  const compareLength = count - maxLag;
  f0Cmnd[0] = 1;
  let runningDifference = 0;
  for (let lag = 1; lag <= maxLag; lag += 1) {
    let difference = 0;
    for (let i = 0; i < compareLength; i += 1) {
      const delta = f0Scratch[i] - f0Scratch[i + lag];
      difference += delta * delta;
    }
    runningDifference += difference;
    f0Cmnd[lag] = runningDifference > 1e-18
      ? (difference * lag) / runningDifference
      : 1;
  }

  let candidate = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (f0Cmnd[lag] >= F0_YIN_THRESHOLD) continue;
    candidate = lag;
    while (candidate < maxLag && f0Cmnd[candidate + 1] < f0Cmnd[candidate]) {
      candidate += 1;
    }
    break;
  }

  if (candidate < 0) {
    candidate = minLag;
    for (let lag = minLag + 1; lag <= maxLag; lag += 1) {
      if (f0Cmnd[lag] < f0Cmnd[candidate]) candidate = lag;
    }
  }

  const confidence = clamp(1 - f0Cmnd[candidate], 0, 1);
  pitchConfidence = confidence;
  if (confidence < F0_MIN_CONFIDENCE) {
    f0Hz = null;
    return;
  }

  let refinedLag = candidate;
  if (candidate > minLag && candidate < maxLag) {
    const before = f0Cmnd[candidate - 1];
    const center = f0Cmnd[candidate];
    const after = f0Cmnd[candidate + 1];
    const denominator = before - 2 * center + after;
    if (Math.abs(denominator) > 1e-12) {
      refinedLag += 0.5 * (before - after) / denominator;
    }
  }

  const frequency = f0SampleRate / refinedLag;
  f0Hz = Number.isFinite(frequency) && frequency >= F0_MIN_HZ && frequency <= F0_MAX_HZ
    ? frequency
    : null;
}

function analyzePcm(buffer) {
  const pcm = new Int16Array(buffer);
  if (pcm.length === 0) return;

  let squareSum = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    const sample = pcm[i] / 32768;
    squareSum += sample * sample;
    pushSpectrumSample(sample);
    pushF0Sample(sample);
  }

  const rms = Math.sqrt(squareSum / pcm.length);
  measureF0(rms);
  self.postMessage({
    type: 'analysis',
    spectrumBands: measureSpectrumBands(),
    f0Hz,
    pitchConfidence,
  });
}

reset(configuredSampleRate);

self.onmessage = (event) => {
  if (event.data?.type === 'configure') {
    reset(Number(event.data.sampleRate));
    return;
  }
  if (event.data?.type === 'pcm' && event.data.buffer instanceof ArrayBuffer) {
    analyzePcm(event.data.buffer);
  }
};
