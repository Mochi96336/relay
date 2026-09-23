const RENDER_QUANTUM = 128;
const INPUT_GAP_DECLICK_MS = 2;

class RelayTabCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSamples = Math.max(128, Math.round(sampleRate * 0.02));
    this.chunk = new Int16Array(this.chunkSamples);
    this.offset = 0;
    this.started = false;
    this.silenceQuanta = 0;
    this.pcmEnvelopeEnabled = false;
    this.chunkStartedAtContextTime = null;

    this.inputGapFadeSamples = Math.max(
      1,
      Math.round((sampleRate * INPUT_GAP_DECLICK_MS) / 1000),
    );
    this.inputGapActive = false;
    this.gapFadeRemainingSamples = 0;
    this.gapFadeStartSample = 0;
    this.recoveryFadeRemainingSamples = 0;
    this.recoveryFadeStartSample = 0;
    this.lastOutputSample = 0;

    // Extension updates can leave an old offscreen document alive briefly
    // while a new worklet file is loaded. Stay on the legacy raw ArrayBuffer
    // wire shape until the new offscreen explicitly opts into timestamps.
    this.port.onmessage = (event) => {
      if (
        event.data?.type === 'capture-protocol'
        && event.data.pcmEnvelope === true
      ) {
        this.pcmEnvelopeEnabled = true;
      }
    };
  }

  writeSample(sample, sampleContextTime) {
    if (this.offset === 0) {
      this.chunkStartedAtContextTime = Number.isFinite(sampleContextTime)
        ? sampleContextTime
        : null;
    }
    this.chunk[this.offset] = sample < 0
      ? Math.round(sample * 32768)
      : Math.round(sample * 32767);
    this.lastOutputSample = sample;
    this.offset += 1;

    if (this.offset >= this.chunk.length) {
      const completed = this.chunk;
      const buffer = completed.buffer;
      const message = this.pcmEnvelopeEnabled
        ? {
            type: 'pcm',
            buffer,
            capturedAtContextTime: this.chunkStartedAtContextTime,
          }
        : buffer;
      this.port.postMessage(message, [buffer]);
      this.chunk = new Int16Array(this.chunkSamples);
      this.offset = 0;
      this.chunkStartedAtContextTime = null;
    }
  }

  beginInputGap() {
    this.inputGapActive = true;
    this.gapFadeStartSample = this.lastOutputSample;
    this.gapFadeRemainingSamples = this.inputGapFadeSamples;
    this.recoveryFadeRemainingSamples = 0;
  }

  gapSample() {
    if (this.gapFadeRemainingSamples <= 0) return 0;
    const total = this.inputGapFadeSamples;
    const progress = total - this.gapFadeRemainingSamples;
    const weight = total <= 1 ? 0 : 1 - (progress / (total - 1));
    this.gapFadeRemainingSamples -= 1;
    return this.gapFadeStartSample * weight;
  }

  beginInputRecovery() {
    this.inputGapActive = false;
    this.recoveryFadeStartSample = this.lastOutputSample;
    this.recoveryFadeRemainingSamples = this.inputGapFadeSamples;
  }

  recoverySample(sample) {
    if (this.recoveryFadeRemainingSamples <= 0) return sample;
    const total = this.inputGapFadeSamples;
    const progress = total - this.recoveryFadeRemainingSamples;
    const weight = total <= 1 ? 1 : progress / (total - 1);
    this.recoveryFadeRemainingSamples -= 1;
    return this.recoveryFadeStartSample * (1 - weight) + sample * weight;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Relay aligns the song against the microphone purely by sample count, so a
    // skipped render quantum here shifts the whole backing timeline forward for
    // good. Emit silence for it instead, matching the microphone capture path.
    if (!input || input.length === 0) {
      if (this.started) {
        this.silenceQuanta += 1;
        if (!this.inputGapActive) this.beginInputGap();
        for (let i = 0; i < RENDER_QUANTUM; i += 1) {
          this.writeSample(this.gapSample(), currentTime + (i / sampleRate));
        }
        if (this.silenceQuanta % 400 === 0) {
          this.port.postMessage({ type: 'input-gap', quanta: this.silenceQuanta });
        }
      }
      if (output?.[0]) output[0].fill(0);
      return true;
    }

    this.started = true;
    if (this.inputGapActive) this.beginInputRecovery();
    const frameCount = input[0]?.length ?? 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        const channelSample = input[channel][frame] ?? 0;
        // One corrupt channel must not turn the mixed sample and subsequent
        // gap/recovery fade state into NaN. Treat only that channel sample as
        // silence while preserving the fixed channel-count average.
        sum += Number.isFinite(channelSample) ? channelSample : 0;
      }
      const realSample = Math.max(-1, Math.min(1, sum / input.length));
      this.writeSample(
        this.recoverySample(realSample),
        currentTime + (frame / sampleRate),
      );
    }

    if (output?.[0]) output[0].fill(0);
    return true;
  }
}

registerProcessor('relay-tab-capture', RelayTabCaptureProcessor);
