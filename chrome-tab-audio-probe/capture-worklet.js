const RENDER_QUANTUM = 128;

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

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Relay aligns the song against the microphone purely by sample count, so a
    // skipped render quantum here shifts the whole backing timeline forward for
    // good. Emit silence for it instead, matching the microphone capture path.
    if (!input || input.length === 0) {
      if (this.started) {
        this.silenceQuanta += 1;
        for (let i = 0; i < RENDER_QUANTUM; i += 1) {
          this.writeSample(0, currentTime + (i / sampleRate));
        }
        if (this.silenceQuanta % 400 === 0) {
          this.port.postMessage({ type: 'input-gap', quanta: this.silenceQuanta });
        }
      }
      if (output?.[0]) output[0].fill(0);
      return true;
    }

    this.started = true;
    const frameCount = input[0]?.length ?? 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      let sum = 0;
      for (let channel = 0; channel < input.length; channel += 1) {
        sum += input[channel][frame] ?? 0;
      }
      this.writeSample(
        Math.max(-1, Math.min(1, sum / input.length)),
        currentTime + (frame / sampleRate),
      );
    }

    if (output?.[0]) output[0].fill(0);
    return true;
  }
}

registerProcessor('relay-tab-capture', RelayTabCaptureProcessor);
