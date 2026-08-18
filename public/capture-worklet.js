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

  writeSilence(count) {
    let remaining = count;
    while (remaining > 0) {
      const room = this.chunkSize - this.offset;
      const step = Math.min(room, remaining);
      this.chunk.fill(0, this.offset, this.offset + step);
      for (let i = 0; i < step; i += 1) this.pushSpectrumSample(0);
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

  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const rms = this.levelSampleCount > 0
      ? Math.sqrt(this.levelSquareSum / this.levelSampleCount)
      : 0;
    this.port.postMessage({
      type: 'input-level',
      peakDbfs: amplitudeToDbfs(this.levelPeak),
      rmsDbfs: amplitudeToDbfs(rms),
      spectrumBands: this.measureSpectrumBands(),
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
