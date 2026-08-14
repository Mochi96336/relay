class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;
    this.prebufferSamples = Math.round(sampleRate * 0.12);

    this.port.onmessage = (event) => {
      if (event.data?.type === 'reset') {
        this.queue = [];
        this.offset = 0;
        this.queuedSamples = 0;
        this.playing = false;
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const samples = new Float32Array(event.data);
        this.queue.push(samples);
        this.queuedSamples += samples.length;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);

    if (!this.playing) {
      if (this.queuedSamples < this.prebufferSamples) return true;
      this.playing = true;
      this.port.postMessage({ type: 'playing' });
    }

    let written = 0;
    while (written < output.length && this.queue.length > 0) {
      const chunk = this.queue[0];
      const available = chunk.length - this.offset;
      const count = Math.min(available, output.length - written);
      output.set(chunk.subarray(this.offset, this.offset + count), written);

      written += count;
      this.offset += count;
      this.queuedSamples -= count;

      if (this.offset === chunk.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }

    if (written < output.length) {
      this.playing = false;
      this.port.postMessage({ type: 'buffering' });
    }

    return true;
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
