const RENDER_QUANTUM = 128;

class RelayTabCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSamples = Math.max(128, Math.round(sampleRate * 0.02));
    this.chunk = new Int16Array(this.chunkSamples);
    this.offset = 0;
    this.started = false;
    this.silenceQuanta = 0;
  }

  writeSample(sample) {
    this.chunk[this.offset] = sample < 0
      ? Math.round(sample * 32768)
      : Math.round(sample * 32767);
    this.offset += 1;

    if (this.offset >= this.chunk.length) {
      const completed = this.chunk;
      this.port.postMessage(completed.buffer, [completed.buffer]);
      this.chunk = new Int16Array(this.chunkSamples);
      this.offset = 0;
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
        for (let i = 0; i < RENDER_QUANTUM; i += 1) this.writeSample(0);
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
      this.writeSample(Math.max(-1, Math.min(1, sum / input.length)));
    }

    if (output?.[0]) output[0].fill(0);
    return true;
  }
}

registerProcessor('relay-tab-capture', RelayTabCaptureProcessor);
