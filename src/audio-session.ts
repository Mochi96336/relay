import { performance } from 'node:perf_hooks';

import type { PcmFrame } from './pcm-frame.js';

/**
 * Owns the live mix: both PCM timelines, the session clock, the alignment the
 * mixer applies, and the health counters that say when any of it is failing.
 *
 * This state used to be a dozen module-level variables in `server.ts`, which
 * meant transport events reached in and reset the mix clock directly. The
 * session is now told what happened - a source appeared, a frame arrived, an
 * alignment was measured - and decides for itself what that does to the audio.
 */

type PcmChunk = {
  start: number;
  samples: Int16Array;
};

type PcmTimeline = {
  chunks: PcmChunk[];
  /** Write frontier on the session timeline, not a count of samples received. */
  totalSamples: number;
  /** Capture session the current mapping was anchored to. */
  generation: number | null;
  /** sessionSample = streamSample + originOffset. */
  originOffset: number;
  /** Samples the timeline is missing: drops, congestion, transport outages. */
  gapSamples: number;
  unheadered: boolean;
};

export type AlignmentState = {
  /** RTT/2 fallback used until an acoustic calibration succeeds. */
  networkCompensationMs: number;
  calibratedMicLagMs: number | null;
  fineTuneMs: number;
};

export type MixHealth = {
  micStarvedFrames: number;
  backingStarvedFrames: number;
  micHeadroomMs: number;
  backingHeadroomMs: number;
  micGapMs: number;
  backingGapMs: number;
  unheadered: boolean;
};

/** Where a batch of ingested samples landed on the shared session timeline. */
export type IngestResult = {
  samples: Int16Array;
  /** Session sample index of the first sample, in mix-rate samples. */
  start: number;
};

export type AudioSessionOptions = {
  sampleRate: number;
  frameMs: number;
  prebufferMs: number;
  backingGain: number;
  /** How far behind the read head to keep audio before discarding it. */
  retentionMs: number;
};

function emptyTimeline(): PcmTimeline {
  return {
    chunks: [],
    totalSamples: 0,
    generation: null,
    originOffset: 0,
    gapSamples: 0,
    unheadered: false,
  };
}

export class AudioSession {
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly frameSamples: number;
  readonly prebufferMs: number;

  private readonly backingGain: number;
  private readonly retentionSamples: number;

  private readonly mic = emptyTimeline();
  private readonly backing = emptyTimeline();

  private running = false;
  private startedAt = 0;
  private frameIndex = 0;
  private sessionGeneration = 0;

  private micExpected = false;
  private backingExpected = false;

  private micGainDb = 30;
  private alignmentState: AlignmentState = {
    networkCompensationMs: 0,
    calibratedMicLagMs: null,
    fineTuneMs: 0,
  };

  private micStarvedFrames = 0;
  private backingStarvedFrames = 0;
  private micHeadroomMs = 0;
  private backingHeadroomMs = 0;

  constructor(options: AudioSessionOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs;
    this.frameSamples = Math.round((options.sampleRate * options.frameMs) / 1000);
    this.prebufferMs = options.prebufferMs;
    this.backingGain = options.backingGain;
    this.retentionSamples = Math.round((options.retentionMs * options.sampleRate) / 1000);
  }

  get active() {
    return this.running;
  }

  /** Increments whenever the mix clock restarts; alignment is scoped to it. */
  get generation() {
    return this.sessionGeneration;
  }

  /** Capture session of the microphone stream currently on the timeline. */
  get micGeneration() {
    return this.mic.generation;
  }

  start(nowMs = performance.now()) {
    this.running = true;
    this.resetEpoch(nowMs);
  }

  stop() {
    this.running = false;
    this.alignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
    this.resetHealth();
  }

  /**
   * Restarts the mix clock. Both timelines must be cleared together or their
   * indices stop describing the same moment.
   */
  resetEpoch(nowMs = performance.now()) {
    this.startedAt = nowMs;
    this.frameIndex = 0;
    this.sessionGeneration += 1;
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
    this.resetHealth();
  }

  /**
   * Whether a source is meant to be streaming. Starvation is only meaningful
   * for a source that is supposed to be there; an absent phone is not a fault.
   */
  setMicExpected(expected: boolean) {
    this.micExpected = expected;
  }

  setBackingExpected(expected: boolean) {
    this.backingExpected = expected;
  }

  setMicGainDb(value: number) {
    this.micGainDb = value;
  }

  get alignment(): AlignmentState {
    return { ...this.alignmentState };
  }

  setAlignment(patch: Partial<AlignmentState>) {
    this.alignmentState = { ...this.alignmentState, ...patch };
  }

  /** Milliseconds the mixer reads ahead in the microphone timeline. */
  get appliedMicAdvanceMs() {
    const base = this.alignmentState.calibratedMicLagMs ?? this.alignmentState.networkCompensationMs;
    return base - this.alignmentState.fineTuneMs;
  }

  ingestMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    return this.ingest(this.mic, frame, sourceRate, nowMs);
  }

  ingestBacking(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    return this.ingest(this.backing, frame, sourceRate, nowMs);
  }

  /** Exposed for the click diagnostic, which mixes against the microphone. */
  readMic(startSample: number, count: number) {
    return this.readRange(this.mic, startSample, count);
  }

  trimMic(beforeSample: number) {
    this.trim(this.mic, beforeSample);
  }

  clearMic() {
    this.clearTimeline(this.mic);
  }

  /** Emits every frame whose time has come. Returns how many were produced. */
  drain(emit: (frame: Buffer) => void, nowMs = performance.now(), maxFrames = 5) {
    if (!this.running) return 0;

    const elapsed = nowMs - this.startedAt - this.prebufferMs;
    if (elapsed < 0) return 0;

    const expected = Math.floor(elapsed / this.frameMs) + 1;
    let remaining = Math.min(maxFrames, expected - this.frameIndex);
    let sent = 0;

    while (remaining > 0) {
      emit(this.mixFrame(this.frameIndex));
      this.frameIndex += 1;
      remaining -= 1;
      sent += 1;
    }

    return sent;
  }

  health(): MixHealth {
    return {
      micStarvedFrames: this.micStarvedFrames,
      backingStarvedFrames: this.backingStarvedFrames,
      micHeadroomMs: Math.round(this.micHeadroomMs),
      backingHeadroomMs: Math.round(this.backingHeadroomMs),
      micGapMs: Math.round((this.mic.gapSamples / this.sampleRate) * 1000),
      backingGapMs: Math.round((this.backing.gapSamples / this.sampleRate) * 1000),
      unheadered: this.mic.unheadered || this.backing.unheadered,
    };
  }

  resetHealth() {
    this.micStarvedFrames = 0;
    this.backingStarvedFrames = 0;
    this.micHeadroomMs = 0;
    this.backingHeadroomMs = 0;
    this.mic.gapSamples = 0;
    this.backing.gapSamples = 0;
  }

  // ---------------------------------------------------------------- internals

  private clearTimeline(timeline: PcmTimeline) {
    timeline.chunks = [];
    timeline.totalSamples = 0;
    timeline.generation = null;
    timeline.originOffset = 0;
    timeline.gapSamples = 0;
  }

  /** Where the session clock is now, in session samples since the epoch. */
  private currentSessionSample(nowMs = performance.now()) {
    return Math.round(((nowMs - this.startedAt) * this.sampleRate) / 1000);
  }

  private ingest(timeline: PcmTimeline, frame: PcmFrame, sourceRate: number | null, nowMs: number): IngestResult {
    if (!sourceRate) return { samples: new Int16Array(0), start: timeline.totalSamples };
    const samples = this.resample(frame.pcm, sourceRate);
    if (samples.length === 0) return { samples, start: timeline.totalSamples };

    let start: number;

    if (frame.firstSampleIndex === null) {
      // No header: the only thing left to do is append at the frontier, which
      // is the old lossy behaviour. Flag it so the UI can say the client is
      // stale rather than letting it degrade invisibly.
      timeline.unheadered = true;
      start = timeline.totalSamples;
    } else {
      // Each frame states its own position, so rounding never accumulates and a
      // missing frame leaves a hole of exactly the right length instead of
      // pulling everything after it earlier.
      const streamStart = Math.round((frame.firstSampleIndex * this.sampleRate) / sourceRate);

      if (timeline.generation !== frame.generation) {
        // A fresh capture session. Anchor it to the session clock; the previous
        // session's samples keep their own place and simply age out.
        timeline.generation = frame.generation;
        timeline.originOffset = Math.max(0, this.currentSessionSample(nowMs) - samples.length) - streamStart;
      }

      start = streamStart + timeline.originOffset;
    }

    if (start < timeline.totalSamples) {
      // Out of order or overlapping. Ordered transport makes this a rounding
      // artefact at worst, so keep the frontier rather than corrupting the sort.
      start = timeline.totalSamples;
    } else if (start > timeline.totalSamples && timeline.chunks.length > 0) {
      timeline.gapSamples += start - timeline.totalSamples;
    }

    timeline.chunks.push({ start, samples });
    timeline.totalSamples = start + samples.length;
    return { samples, start };
  }

  private resample(buffer: Buffer, sourceRate: number) {
    const inputLength = Math.floor(buffer.byteLength / 2);
    if (inputLength <= 0) return new Int16Array(0);
    if (sourceRate === this.sampleRate) {
      const output = new Int16Array(inputLength);
      for (let i = 0; i < inputLength; i += 1) output[i] = buffer.readInt16LE(i * 2);
      return output;
    }

    const outputLength = Math.max(1, Math.round((inputLength * this.sampleRate) / sourceRate));
    const output = new Int16Array(outputLength);
    const ratio = sourceRate / this.sampleRate;

    const readSample = (index: number) => {
      const bounded = Math.max(0, Math.min(inputLength - 1, index));
      return buffer.readInt16LE(bounded * 2);
    };

    for (let i = 0; i < outputLength; i += 1) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = readSample(index);
      const b = readSample(index + 1);
      output[i] = Math.round(a + (b - a) * fraction);
    }

    return output;
  }

  private firstChunkAtOrBefore(timeline: PcmTimeline, sampleIndex: number) {
    let low = 0;
    let high = timeline.chunks.length - 1;
    let result = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timeline.chunks[mid].start <= sampleIndex) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return result;
  }

  private readRange(timeline: PcmTimeline, startSample: number, count: number) {
    const output = new Int16Array(count);
    if (timeline.chunks.length === 0) return output;

    let outputOffset = 0;
    let cursor = startSample;

    if (cursor < 0) {
      const silence = Math.min(count, -cursor);
      outputOffset += silence;
      cursor += silence;
    }

    if (outputOffset >= count || cursor >= timeline.totalSamples) return output;

    let chunkIndex = this.firstChunkAtOrBefore(timeline, cursor);
    while (chunkIndex < timeline.chunks.length && outputOffset < count) {
      const chunk = timeline.chunks[chunkIndex];
      const chunkEnd = chunk.start + chunk.samples.length;

      if (cursor >= chunkEnd) {
        chunkIndex += 1;
        continue;
      }

      // A hole in the timeline reads as the silence that actually happened.
      if (cursor < chunk.start) {
        const silence = Math.min(count - outputOffset, chunk.start - cursor);
        outputOffset += silence;
        cursor += silence;
        continue;
      }

      const sourceOffset = cursor - chunk.start;
      const available = chunk.samples.length - sourceOffset;
      const copyCount = Math.min(count - outputOffset, available);
      output.set(chunk.samples.subarray(sourceOffset, sourceOffset + copyCount), outputOffset);
      outputOffset += copyCount;
      cursor += copyCount;
      chunkIndex += 1;
    }

    return output;
  }

  private trim(timeline: PcmTimeline, beforeSample: number) {
    while (timeline.chunks.length > 1) {
      const chunk = timeline.chunks[0];
      if (chunk.start + chunk.samples.length >= beforeSample) break;
      timeline.chunks.shift();
    }
  }

  private mixFrame(frameIndex: number) {
    const startSample = frameIndex * this.frameSamples;
    const advanceSamples = Math.round((this.appliedMicAdvanceMs * this.sampleRate) / 1000);
    const micReadStart = startSample + advanceSamples;

    // Reading ahead can outrun what has actually arrived. readRange pads with
    // zeros when that happens, so without this the vocal simply disappears in
    // chunks and nothing anywhere says why.
    this.micHeadroomMs = ((this.mic.totalSamples - (micReadStart + this.frameSamples)) / this.sampleRate) * 1000;
    this.backingHeadroomMs = ((this.backing.totalSamples - (startSample + this.frameSamples)) / this.sampleRate) * 1000;
    if (this.micHeadroomMs < 0 && this.micExpected) this.micStarvedFrames += 1;
    if (this.backingHeadroomMs < 0 && this.backingExpected) this.backingStarvedFrames += 1;

    const mic = this.readRange(this.mic, micReadStart, this.frameSamples);
    const song = this.readRange(this.backing, startSample, this.frameSamples);
    const micGain = 10 ** (this.micGainDb / 20);
    const output = Buffer.allocUnsafe(this.frameSamples * 2);

    for (let i = 0; i < this.frameSamples; i += 1) {
      const value = (mic[i] / 32768) * micGain + (song[i] / 32768) * this.backingGain;
      const clamped = Math.max(-1, Math.min(1, value));
      output.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
    }

    this.trim(this.mic, startSample - this.retentionSamples);
    this.trim(this.backing, startSample - this.sampleRate);
    return output;
  }
}
