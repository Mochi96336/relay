class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunkSize = Math.max(128, Math.round(sampleRate * 0.02));
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;

    let sourceOffset = 0;
    while (sourceOffset < input.length) {
      const remaining = this.chunkSize - this.offset;
      const count = Math.min(remaining, input.length - sourceOffset);

      for (let i = 0; i < count; i += 1) {
        const sample = Math.max(-1, Math.min(1, input[sourceOffset + i]));
        this.chunk[this.offset + i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      }

      this.offset += count;
      sourceOffset += count;

      if (this.offset === this.chunkSize) {
        const buffer = this.chunk.buffer;
        this.port.postMessage(buffer, [buffer]);
        this.chunk = new Int16Array(this.chunkSize);
        this.offset = 0;
      }
    }

    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
