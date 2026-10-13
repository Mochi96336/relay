import {
  emptyPcmTimeline, readPcmEvidence, readPcmRange,
  type PcmTimeline, type PcmChunk,
} from './pcm-timeline.js';

/**
 * Bounded extra Content-analysis history, independent of the playback
 * MicTrack/Robot retention. It copies ONLY PCM chunks accepted by canonical
 * ingest, never client-declared timestamps or zero-padded read output.
 *
 * A capture-generation/source-rate change clears all earlier samples.
 * The maximum resident PCM is capped to maxSamples, even for a 2s packet.
 * A clipped old chunk cannot later be mistaken for a complete 6s window.
 */
export class ChoirContentPcmBuffer {
  private history: PcmTimeline = emptyPcmTimeline();
  private readonly maxSamples: number;
  private captureStart: number | null = null;

  constructor(sampleRate: number, retentionMs: number) {
    if (!Number.isInteger(sampleRate) || sampleRate <= 0
      || !Number.isFinite(retentionMs) || retentionMs < 6_000
      || retentionMs > 10_000)
      throw new RangeError('Choir Content history must retain 6-10 seconds');
    this.maxSamples = Math.ceil(sampleRate * retentionMs / 1_000);
  }

  reset() {
    this.history = emptyPcmTimeline();
    this.captureStart = null;
  }

  /** Call only after canonical ingest, with the previous source chunk count. */
  captureAccepted(source: PcmTimeline, priorChunkCount: number) {
    if (source.generation === null || source.sourceRate === null) return;
    if (this.history.generation !== source.generation
      || this.history.sourceRate !== source.sourceRate) {
      this.reset();
      this.history.generation = source.generation;
      this.history.sourceRate = source.sourceRate;
    }
    for (let i = priorChunkCount; i < source.chunks.length; i++) {
      const chunk = source.chunks[i];
      if (!chunk || !Number.isSafeInteger(chunk.start) || chunk.start < 0
        || chunk.samples.length === 0) continue;
      if (this.captureStart === null) this.captureStart = chunk.start;
      const copied: PcmChunk = {
        start: chunk.start, samples: chunk.samples.slice(),
        positioned: chunk.positioned, concealed: chunk.concealed,
      };
      // Source ingest is append-only. A late overlap never rewrites an
      // already accepted acoustic sample in the calibration buffer.
      if (copied.start < this.history.totalSamples) {
        const overlap = this.history.totalSamples - copied.start;
        if (overlap >= copied.samples.length) continue;
        copied.samples = copied.samples.slice(overlap);
        copied.start = this.history.totalSamples;
      }
      this.history.chunks.push(copied);
      this.history.totalSamples = copied.start + copied.samples.length;
    }
    this.trim();
  }

  private trim() {
    const oldest = Math.max(0, this.history.totalSamples - this.maxSamples);
    while (this.history.chunks.length
      && this.history.chunks[0].start + this.history.chunks[0].samples.length <= oldest)
      this.history.chunks.shift();
    if (this.history.chunks.length && this.history.chunks[0].start < oldest) {
      const first = this.history.chunks[0];
      this.history.chunks[0] = {
        ...first, start: oldest,
        samples: first.samples.slice(oldest - first.start),
      };
    }
  }

  hasFullPositionedWindow(
    generation: number, sourceRate: number,
    startSample: number, count: number,
  ) {
    if (!Number.isSafeInteger(startSample) || startSample < 0
      || !Number.isSafeInteger(count) || count <= 0
      || !Number.isSafeInteger(startSample + count)
      || this.history.generation !== generation
      || this.history.sourceRate !== sourceRate
      || this.captureStart === null || startSample < this.captureStart
      || startSample + count > this.history.totalSamples) return false;
    // The first chunk may have been evicted even though totalSamples is high.
    if (!this.history.chunks.length || startSample < this.history.chunks[0].start)
      return false;
    const evidence = readPcmEvidence(this.history, startSample, count);
    return evidence.gapSamples === 0 && evidence.frontierMissingSamples === 0
      && evidence.unheaderedSamples === 0;
  }

  read(startSample: number, count: number): Int16Array {
    return readPcmRange(this.history, startSample, count);
  }

  get sampleCount() {
    return this.history.chunks.reduce((count, c) => count + c.samples.length, 0);
  }
}
