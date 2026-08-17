const RENDER_QUANTUM = 128;

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
    while (remaining > 0) {
      const room = this.chunkSize - this.offset;
      const step = Math.min(room, remaining);
      this.chunk.fill(0, this.offset, this.offset + step);
      this.offset += step;
      remaining -= step;
      this.flushIfFull();
    }
  }

  flushIfFull() {
    if (this.offset !== this.chunkSize) return;
    const buffer = this.chunk.buffer;
    this.port.postMessage(buffer, [buffer]);
    this.chunk = new Int16Array(this.chunkSize);
    this.offset = 0;
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
