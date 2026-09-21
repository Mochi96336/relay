const RENDER_QUANTUM = 128;
const SILENCE_DBFS = -120;
// Narrow enough that an unclipped voice peak normally touches it for at most
// one sample. A flat-topped capture instead produces a run of rail samples.
const INPUT_RAIL_THRESHOLD = 1 - 1e-6;
const VISUAL_ANALYSIS_PLACEHOLDER = Object.freeze({
  spectrumBands: Object.freeze([0, 0, 0, 0, 0]),
  f0Hz: null,
  pitchConfidence: 0,
});

function amplitudeToDbfs(amplitude) {
  return amplitude > 0 ? 20 * Math.log10(amplitude) : SILENCE_DBFS;
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
    // Capture-lifetime evidence, not a one-frame alarm. A 1 Hz health snapshot
    // must not miss a short clipped syllable that happened between reports.
    this.railSamples = 0;
    this.currentRailRunSamples = 0;
    this.maxConsecutiveRailSamples = 0;
    this.chunkStartedAtContextTime = null;

    // Rollout compatibility is deliberately asymmetric: a newly deployed
    // worklet can be loaded by a page whose old app.js has been open across the
    // deploy. That app only understands raw ArrayBuffer PCM. Stay on the legacy
    // wire shape until a new app explicitly opts into the timestamp envelope.
    this.pcmEnvelopeEnabled = false;
    this.port.onmessage = (event) => {
      if (
        event.data?.type === 'capture-protocol'
        && event.data.pcmEnvelope === true
      ) {
        this.pcmEnvelopeEnabled = true;
      }
    };
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

  writeSilence(count) {
    let remaining = count;
    let written = 0;
    while (remaining > 0) {
      if (this.offset === 0) {
        this.chunkStartedAtContextTime = (
          typeof currentTime === 'number' && Number.isFinite(currentTime)
            ? currentTime + (written / sampleRate)
            : null
        );
      }
      const room = this.chunkSize - this.offset;
      const step = Math.min(room, remaining);
      this.chunk.fill(0, this.offset, this.offset + step);
      this.offset += step;
      this.levelSampleCount += step;
      // A real input gap is silence, not clipping, and terminates any preceding
      // rail run so two unrelated peaks cannot be joined across missing input.
      this.currentRailRunSamples = 0;
      remaining -= step;
      written += step;
      this.flushIfFull();
    }
  }

  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const rms = this.levelSampleCount > 0
      ? Math.sqrt(this.levelSquareSum / this.levelSampleCount)
      : 0;
    const peakDbfs = amplitudeToDbfs(this.levelPeak);
    const rmsDbfs = amplitudeToDbfs(rms);
    const samples = this.levelSampleCount;

    // PCM is the only realtime payload this AudioWorklet owns. Spectrum and
    // pitch are intentionally analysed in a dedicated Worker after the PCM has
    // reached the page, so visual DSP can never consume an audio render deadline.
    const buffer = this.chunk.buffer;
    const pcmMessage = this.pcmEnvelopeEnabled
      ? {
          type: 'pcm',
          buffer,
          // Timestamp the oldest sample in this chunk, not the flush point.
          // Otherwise a 20 ms chunk can be almost 20 ms older than its reported
          // age, quietly widening the 200 ms realtime backlog budget.
          capturedAtContextTime: this.chunkStartedAtContextTime,
        }
      : buffer;
    this.port.postMessage(pcmMessage, [buffer]);
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
    this.chunkStartedAtContextTime = null;
    this.levelPeak = 0;
    this.levelSquareSum = 0;
    this.levelSampleCount = 0;

    // Keep the old message shape for a cached pre-worker app.js during rolling
    // deploys. New pages replace these neutral fields with dedicated-Worker
    // analysis; old pages still retain a working local level meter.
    this.port.postMessage({
      type: 'input-level',
      peakDbfs,
      rmsDbfs,
      spectrumBands: VISUAL_ANALYSIS_PLACEHOLDER.spectrumBands,
      f0Hz: VISUAL_ANALYSIS_PLACEHOLDER.f0Hz,
      pitchConfidence: VISUAL_ANALYSIS_PLACEHOLDER.pitchConfidence,
      samples,
      railSamples: this.railSamples,
      maxConsecutiveRailSamples: this.maxConsecutiveRailSamples,
    });
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
      if (this.offset === 0) {
        this.chunkStartedAtContextTime = (
          typeof currentTime === 'number' && Number.isFinite(currentTime)
            ? currentTime + (sourceOffset / sampleRate)
            : null
        );
      }
      const remaining = this.chunkSize - this.offset;
      const count = Math.min(remaining, input.length - sourceOffset);

      for (let i = 0; i < count; i += 1) {
        const rawSample = input[sourceOffset + i];
        const sample = Math.max(-1, Math.min(1, rawSample));
        const magnitude = Math.abs(sample);
        this.levelPeak = Math.max(this.levelPeak, magnitude);
        this.levelSquareSum += sample * sample;
        this.levelSampleCount += 1;

        if (Math.abs(rawSample) >= INPUT_RAIL_THRESHOLD) {
          this.railSamples += 1;
          this.currentRailRunSamples += 1;
          this.maxConsecutiveRailSamples = Math.max(
            this.maxConsecutiveRailSamples,
            this.currentRailRunSamples,
          );
        } else {
          this.currentRailRunSamples = 0;
        }

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
