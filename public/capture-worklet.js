const RENDER_QUANTUM = 128;
const SILENCE_DBFS = -120;
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

function amplitudeToDbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : SILENCE_DBFS;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.max(128, Math.round(sampleRate * 0.02));
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.started = false;
    this.silenceQuanta = 0;
    this.activeGapQuanta = 0;
    this.reportedActiveGapQuanta = 0;
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;

    // Visual spectrum evidence stays inside the capture worklet so the main
    // thread never needs a second copy of live PCM just to draw the Mic. The
    // ring stores the most recent 512 source samples (about 10.7 ms at 48 kHz)
    // and the FFT runs only once per existing 20 ms capture chunk.
    this.spectrumRing = new Float32Array(SPECTRUM_FFT_SIZE);
    this.spectrumWrite = 0;
    this.spectrumSamples = 0;
    this.fftReal = new Float32Array(SPECTRUM_FFT_SIZE);
    this.fftImag = new Float32Array(SPECTRUM_FFT_SIZE);
    this.fftWindow = new Float32Array(SPECTRUM_FFT_SIZE);
    for (let i = 0; i < SPECTRUM_FFT_SIZE; i += 1) {
      this.fftWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (SPECTRUM_FFT_SIZE - 1));
    }

    // F0 is a visual side-channel only. Downsample the source into a separate
    // ring and run a normalized YIN-style difference detector every 40 ms.
    // Nothing here changes the PCM chunk, its framing, or its sample cursor.
    this.f0DownsampleFactor = Math.max(1, Math.round(sampleRate / F0_DOWNSAMPLE_TARGET_HZ));
    this.f0SampleRate = sampleRate / this.f0DownsampleFactor;
    this.f0Ring = new Float32Array(F0_RING_SIZE);
    this.f0Write = 0;
    this.f0Samples = 0;
    this.f0DecimationSum = 0;
    this.f0DecimationCount = 0;
    this.f0Scratch = new Float32Array(F0_RING_SIZE);
    this.f0Cmnd = new Float32Array(Math.ceil(this.f0SampleRate / F0_MIN_HZ) + 2);
    this.f0ChunksSinceEstimate = 0;
    this.f0Hz = null;
    this.pitchConfidence = 0;
  }

  reportInputGap(recovered) {
    const unreported = this.activeGapQuanta - this.reportedActiveGapQuanta;
    if (unreported <= 0) return;
    this.reportedActiveGapQuanta = this.activeGapQuanta;
    this.port.postMessage({
      type: 'input-gap',
      quanta: unreported,
      samples: unreported * RENDER_QUANTUM,
      totalQuanta: this.silenceQuanta,
      recovered,
    });
  }

  pushSpectrumSample(sample) {
    this.spectrumRing[this.spectrumWrite] = sample;
    this.spectrumWrite = (this.spectrumWrite + 1) % SPECTRUM_FFT_SIZE;
    this.spectrumSamples = Math.min(SPECTRUM_FFT_SIZE, this.spectrumSamples + 1);
  }

  pushF0Sample(sample) {
    this.f0DecimationSum += sample;
    this.f0DecimationCount += 1;
    if (this.f0DecimationCount < this.f0DownsampleFactor) return;

    this.f0Ring[this.f0Write] = this.f0DecimationSum / this.f0DecimationCount;
    this.f0Write = (this.f0Write + 1) % F0_RING_SIZE;
    this.f0Samples = Math.min(F0_RING_SIZE, this.f0Samples + 1);
    this.f0DecimationSum = 0;
    this.f0DecimationCount = 0;
  }

  writeSilence(count) {
    let remaining = count;
    while (remaining > 0) {
      const room = this.chunkSize - this.offset;
      const step = Math.min(room, remaining);
      this.chunk.fill(0, this.offset, this.offset + step);
      for (let i = 0; i < step; i += 1) {
        this.pushSpectrumSample(0);
        this.pushF0Sample(0);
      }
      this.offset += step;
      this.levelSampleCount += step;
      remaining -= step;
      this.flushIfFull();
    }
  }

  runFft() {
    const n = SPECTRUM_FFT_SIZE;

    // Copy the ring in chronological order and apply a Hann window before the
    // in-place radix-2 FFT. This is analysis-only evidence; it never touches
    // the PCM buffer that is sent to Relay.
    const missing = n - this.spectrumSamples;
    for (let i = 0; i < n; i += 1) {
      let sample = 0;
      if (i >= missing) {
        const logical = i - missing;
        const oldest = this.spectrumSamples === n ? this.spectrumWrite : 0;
        const source = (oldest + logical) % n;
        sample = this.spectrumRing[source];
      }
      this.fftReal[i] = sample * this.fftWindow[i];
      this.fftImag[i] = 0;
    }

    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      while (j & bit) {
        j ^= bit;
        bit >>= 1;
      }
      j ^= bit;
      if (i >= j) continue;
      const real = this.fftReal[i];
      const imag = this.fftImag[i];
      this.fftReal[i] = this.fftReal[j];
      this.fftImag[i] = this.fftImag[j];
      this.fftReal[j] = real;
      this.fftImag[j] = imag;
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
          const oddReal = this.fftReal[odd] * wCos - this.fftImag[odd] * wSin;
          const oddImag = this.fftReal[odd] * wSin + this.fftImag[odd] * wCos;
          const evenReal = this.fftReal[even];
          const evenImag = this.fftImag[even];

          this.fftReal[even] = evenReal + oddReal;
          this.fftImag[even] = evenImag + oddImag;
          this.fftReal[odd] = evenReal - oddReal;
          this.fftImag[odd] = evenImag - oddImag;

          const nextCos = wCos * stepCos - wSin * stepSin;
          wSin = wCos * stepSin + wSin * stepCos;
          wCos = nextCos;
        }
      }
    }
  }

  measureSpectrumBands() {
    this.runFft();
    const bandDb = [];
    const binHz = sampleRate / SPECTRUM_FFT_SIZE;

    for (const [lowHz, highHz] of SPECTRUM_BANDS_HZ) {
      const startBin = Math.max(1, Math.ceil(lowHz / binHz));
      const endBin = Math.min((SPECTRUM_FFT_SIZE >> 1) - 1, Math.floor(highHz / binHz));
      let power = 0;
      let count = 0;
      for (let bin = startBin; bin <= endBin; bin += 1) {
        const real = this.fftReal[bin];
        const imag = this.fftImag[bin];
        power += real * real + imag * imag;
        count += 1;
      }
      const meanPower = count > 0 ? power / count : 0;
      bandDb.push(10 * Math.log10(meanPower + 1e-12));
    }

    const strongest = Math.max(...bandDb);
    return bandDb.map((value) => {
      const relative = clamp((value - (strongest - SPECTRUM_DYNAMIC_RANGE_DB)) / SPECTRUM_DYNAMIC_RANGE_DB, 0, 1);
      return Math.pow(relative, 0.72);
    });
  }

  measureF0(rms) {
    if (rms < F0_SILENCE_RMS) {
      this.f0ChunksSinceEstimate = 0;
      this.f0Hz = null;
      this.pitchConfidence = 0;
      return;
    }

    this.f0ChunksSinceEstimate += 1;
    if (this.f0ChunksSinceEstimate < F0_ANALYSIS_CHUNKS) return;
    this.f0ChunksSinceEstimate = 0;

    const count = Math.min(this.f0Samples, F0_RING_SIZE);
    const minLag = Math.max(2, Math.floor(this.f0SampleRate / F0_MAX_HZ));
    const maxLag = Math.min(
      this.f0Cmnd.length - 2,
      Math.ceil(this.f0SampleRate / F0_MIN_HZ),
    );
    if (count < maxLag + minLag + 8) {
      this.f0Hz = null;
      this.pitchConfidence = 0;
      return;
    }

    const oldest = this.f0Samples === F0_RING_SIZE ? this.f0Write : 0;
    for (let i = 0; i < count; i += 1) {
      this.f0Scratch[i] = this.f0Ring[(oldest + i) % F0_RING_SIZE];
    }

    const compareLength = count - maxLag;
    this.f0Cmnd[0] = 1;
    let runningDifference = 0;
    for (let lag = 1; lag <= maxLag; lag += 1) {
      let difference = 0;
      for (let i = 0; i < compareLength; i += 1) {
        const delta = this.f0Scratch[i] - this.f0Scratch[i + lag];
        difference += delta * delta;
      }
      runningDifference += difference;
      this.f0Cmnd[lag] = runningDifference > 1e-18
        ? (difference * lag) / runningDifference
        : 1;
    }

    let candidate = -1;
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      if (this.f0Cmnd[lag] >= F0_YIN_THRESHOLD) continue;
      candidate = lag;
      while (candidate < maxLag && this.f0Cmnd[candidate + 1] < this.f0Cmnd[candidate]) {
        candidate += 1;
      }
      break;
    }

    if (candidate < 0) {
      candidate = minLag;
      for (let lag = minLag + 1; lag <= maxLag; lag += 1) {
        if (this.f0Cmnd[lag] < this.f0Cmnd[candidate]) candidate = lag;
      }
    }

    const confidence = clamp(1 - this.f0Cmnd[candidate], 0, 1);
    this.pitchConfidence = confidence;
    if (confidence < F0_MIN_CONFIDENCE) {
      this.f0Hz = null;
      return;
    }

    let refinedLag = candidate;
    if (candidate > minLag && candidate < maxLag) {
      const before = this.f0Cmnd[candidate - 1];
      const center = this.f0Cmnd[candidate];
      const after = this.f0Cmnd[candidate + 1];
      const denominator = before - 2 * center + after;
      if (Math.abs(denominator) > 1e-12) {
        refinedLag += 0.5 * (before - after) / denominator;
      }
    }

    const frequency = this.f0SampleRate / refinedLag;
    this.f0Hz = Number.isFinite(frequency) && frequency >= F0_MIN_HZ && frequency <= F0_MAX_HZ
      ? frequency
      : null;
  }

  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const rms = this.levelSampleCount > 0
      ? Math.sqrt(this.levelSquareSum / this.levelSampleCount)
      : 0;
    this.measureF0(rms);
    this.port.postMessage({
      type: 'input-level',
      peakDbfs: amplitudeToDbfs(this.levelPeak),
      rmsDbfs: amplitudeToDbfs(rms),
      spectrumBands: this.measureSpectrumBands(),
      f0Hz: this.f0Hz,
      pitchConfidence: this.pitchConfidence,
      samples: this.levelSampleCount,
    });

    const buffer = this.chunk.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];

    // Everything downstream aligns purely by sample count, so a gap here shifts
    // the whole microphone timeline forward for good. Emit silence for the
    // missing render quantum instead of skipping it.
    if (!input) {
      if (this.started) {
        this.silenceQuanta += 1;
        this.activeGapQuanta += 1;
        this.writeSilence(RENDER_QUANTUM);
        if (this.activeGapQuanta - this.reportedActiveGapQuanta >= 400) {
          this.reportInputGap(false);
        }
      }
      return true;
    }

    if (this.activeGapQuanta > 0) {
      this.reportInputGap(true);
      this.activeGapQuanta = 0;
      this.reportedActiveGapQuanta = 0;
    }
    this.started = true;
    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const remaining = this.chunkSize - this.offset;
      const count = Math.min(remaining, input.length - sourceOffset);

      for (let i = 0; i < count; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[sourceOffset + i]));
        const magnitude = Math.abs(sample);
        this.levelPeak = Math.max(this.levelPeak, magnitude);
        this.levelSquareSum += sample * sample;
        this.levelSampleCount += 1;
        this.pushSpectrumSample(sample);
        this.pushF0Sample(sample);
        this.chunk[this.offset + i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      this.offset += count;
      sourceOffset += count;
      this.flushIfFull();
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
