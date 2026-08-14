const DEFAULT_PREBUFFER_MS = 300;
const DEFAULT_MAX_QUEUE_MS = 2_000;
const REPORT_INTERVAL_MS = 500;

// The old processor re-buffered from empty after every shortfall and used a
// 120 ms target. A single late frame therefore wrote ~120 ms of real silence
// into whatever was listening, and Solo recording captures this node live, so
// each shortfall was baked into the file. A larger steady-state buffer makes
// shortfalls rare; a queue ceiling stops the server's post-stall catch-up burst
// from turning into permanent latency.
class PlaybackProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;

    this.underruns = 0;
    this.droppedSamples = 0;
    this.starvedSamples = 0;
    this.reportCountdown = 0;

    this.configure({});

    this.port.onmessage = (event) => {
      const data = event.data;

      if (data instanceof ArrayBuffer) {
        this.push(new Float32Array(data));
        return;
      }

      if (data?.type === 'reset') {
        this.reset();
        return;
      }

      if (data?.type === 'configure') {
        this.configure(data);
      }
    };
  }

  configure(options) {
    const prebufferMs = Number(options.prebufferMs);
    const maxQueueMs = Number(options.maxQueueMs);

    this.prebufferSamples = Math.round(
      (sampleRate * (Number.isFinite(prebufferMs) ? prebufferMs : DEFAULT_PREBUFFER_MS)) / 1000,
    );
    this.maxQueueSamples = Math.round(
      (sampleRate * (Number.isFinite(maxQueueMs) ? maxQueueMs : DEFAULT_MAX_QUEUE_MS)) / 1000,
    );
    // The ceiling must stay above the fill target or playback could never start.
    this.maxQueueSamples = Math.max(this.maxQueueSamples, this.prebufferSamples * 2);
    this.reportEvery = Math.max(1, Math.round((sampleRate * REPORT_INTERVAL_MS) / (1000 * 128)));
  }

  reset() {
    this.queue = [];
    this.offset = 0;
    this.queuedSamples = 0;
    this.playing = false;
  }

  push(samples) {
    if (samples.length === 0) return;
    this.queue.push(samples);
    this.queuedSamples += samples.length;

    // Trim from the front: the newest audio is the one that keeps output in
    // step with real time, so an overlong queue means latency, not content.
    while (this.queuedSamples > this.maxQueueSamples && this.queue.length > 1) {
      const oldest = this.queue[0];
      const usable = oldest.length - this.offset;
      this.queue.shift();
      this.offset = 0;
      this.queuedSamples -= usable;
      this.droppedSamples += usable;
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0][0];
    output.fill(0);

    if (!this.playing) {
      if (this.queuedSamples < this.prebufferSamples) {
        this.report(output.length);
        return true;
      }
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
      this.underruns += 1;
      this.starvedSamples += output.length - written;
      this.port.postMessage({ type: 'buffering' });
    }

    this.report(0);
    return true;
  }

  report(starved) {
    this.starvedSamples += starved;
    this.reportCountdown -= 1;
    if (this.reportCountdown > 0) return;
    this.reportCountdown = this.reportEvery;

    this.port.postMessage({
      type: 'health',
      queuedMs: (this.queuedSamples / sampleRate) * 1000,
      underruns: this.underruns,
      droppedMs: (this.droppedSamples / sampleRate) * 1000,
      starvedMs: (this.starvedSamples / sampleRate) * 1000,
      playing: this.playing,
    });
  }
}

registerProcessor('playback-processor', PlaybackProcessor);
