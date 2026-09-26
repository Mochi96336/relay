/**
 * Cuts the Robot capture's raw mono PCM16 byte stream into whole frames.
 *
 * The capture tool writes into a pipe, and a pipe read returns whatever
 * happens to be there: nothing guarantees a chunk ends on a sample boundary.
 * Steady-state framing already keeps any partial sample for the next chunk.
 * The startup flush used to drop whole chunks instead, so one odd-length chunk
 * in that window left every later sample read one byte out of place - full
 * scale noise for as long as the bridge ran. The flush now counts what it
 * discarded and drops the orphaned second byte of a split sample.
 */
export type BackingPcmFramerOptions = {
  frameBytes: number;
  /**
   * How long to discard audio after the first byte arrives. See
   * RELAY_BACKING_STARTUP_FLUSH_MS in backing-stdin.ts.
   */
  startupFlushMs: number;
};

export type BackingPcmFramerPush = {
  frames: Buffer[];
  /** Bytes the startup flush discarded, reported once when it ends. */
  flushEndedAfterBytes: number | null;
};

export class BackingPcmFramer {
  readonly frameBytes: number;
  private readonly startupFlushMs: number;
  // Annotated, not inferred: `Buffer.alloc` narrows to `Buffer<ArrayBuffer>`,
  // while stdin hands out the wider `Buffer<ArrayBufferLike>`.
  private pending: Buffer = Buffer.alloc(0);
  private flushing: boolean;
  private flushUntil: number | null = null;
  private flushedBytes = 0;

  constructor(options: BackingPcmFramerOptions) {
    if (!Number.isInteger(options.frameBytes) || options.frameBytes < 2 || options.frameBytes % 2 !== 0) {
      throw new RangeError('frameBytes must be a positive even integer');
    }
    if (!Number.isFinite(options.startupFlushMs) || options.startupFlushMs < 0) {
      throw new RangeError('startupFlushMs must be non-negative');
    }
    this.frameBytes = options.frameBytes;
    this.startupFlushMs = options.startupFlushMs;
    this.flushing = options.startupFlushMs > 0;
  }

  push(chunk: Buffer, nowMs: number): BackingPcmFramerPush {
    let flushEndedAfterBytes: number | null = null;
    let input = chunk;
    if (this.flushing) {
      if (this.flushUntil === null) this.flushUntil = nowMs + this.startupFlushMs;
      if (nowMs < this.flushUntil) {
        this.flushedBytes += input.byteLength;
        return { frames: [], flushEndedAfterBytes };
      }
      this.flushing = false;
      flushEndedAfterBytes = this.flushedBytes;
      // The flush ended inside a sample: its second byte starts this chunk.
      if (this.flushedBytes % 2 !== 0) input = input.subarray(1);
    }

    this.pending = this.pending.length === 0 ? input : Buffer.concat([this.pending, input]);
    const frames: Buffer[] = [];
    while (this.pending.length >= this.frameBytes) {
      // Copy because ws may retain the Buffer after the pending window moves.
      frames.push(Buffer.from(this.pending.subarray(0, this.frameBytes)));
      this.pending = this.pending.subarray(this.frameBytes);
    }
    return { frames, flushEndedAfterBytes };
  }

  /**
   * The final whole samples on a clean shutdown, still valid PCM, or null.
   * A trailing half sample is not.
   */
  takeTail(): Buffer | null {
    const evenBytes = this.pending.length - (this.pending.length % 2);
    const tail = evenBytes > 0 ? Buffer.from(this.pending.subarray(0, evenBytes)) : null;
    this.pending = Buffer.alloc(0);
    return tail;
  }
}
