/**
 * One source's PCM placed on the shared session timeline, and the pure reads
 * and edits the mixer makes of it.
 *
 * AudioSession keeps one timeline per source and decides what arrives on it;
 * everything here only stores, reads, trims and resamples. None of it knows
 * about the mix clock, alignment or which source it is, so each piece can be
 * tested on its own.
 */

export type PcmChunk = {
  start: number;
  samples: Int16Array;
  positioned: boolean;
  /**
   * Synthetic fill inside a real positioned hole. It is audible, but every
   * evidence reader still counts it as the gap it stands in for.
   */
  concealed?: boolean;
};

export type PcmTimeline = {
  chunks: PcmChunk[];
  /** Write frontier on the session timeline, not a count of samples received. */
  totalSamples: number;
  /** Capture session the current mapping was anchored to. */
  generation: number | null;
  /** Source sample rate that gives this capture generation's indices their units. */
  sourceRate: number | null;
  /** sessionSample = streamSample + originOffset. */
  originOffset: number;
  /** Samples the timeline is missing: drops, congestion, transport outages. */
  gapSamples: number;
  unheadered: boolean;
  /** Smoothed difference between this source clock and the mix clock. */
  clockErrorSamples: number;
  /** Raw source frontier used to distinguish clock drift from real packet gaps. */
  sourceFrontier: number | null;
  /** Samples inserted to keep a slower continuous local source on time. */
  clockCorrectionSamples: number;
  /**
   * Last raw source samples (up to three, oldest first) from the furthest
   * accepted positioned packet. A phase-correct cubic resampler needs them when
   * the next transport packet begins between two target-rate sample positions.
   */
  resampleTail: number[];
  /**
   * Next absolute mix-rate sample on the source clock that still needs to be
   * emitted. Upsampling may defer one target sample until the following source
   * packet supplies the interpolation endpoint.
   */
  resampleNextTargetSample: number | null;
};

/** Narrow, read-only structure used by PCM readers; no capture or edit authority. */
export type PcmTimelineReadView = {
  readonly chunks: readonly Readonly<PcmChunk>[];
  readonly totalSamples: number;
};

export type PcmEvidence = {
  gapSamples: number;
  frontierMissingSamples: number;
  unheaderedSamples: number;
};

/** Bits of a per-sample source evidence mask (readPcmSourceEvidence). */
export const SOURCE_GAP = 1;
export const SOURCE_PAST_FRONTIER = 2;
export const SOURCE_UNHEADERED = 4;
/** Concealment fill: audible, but still missing evidence. */
export const SOURCE_CONCEALED = 8;

/** Source samples a deferred cubic target can still need from the previous packet. */
export const RESAMPLE_TAIL_SAMPLES = 3;

export function emptyPcmTimeline(): PcmTimeline {
  return {
    chunks: [],
    totalSamples: 0,
    generation: null,
    sourceRate: null,
    originOffset: 0,
    gapSamples: 0,
    unheadered: false,
    clockErrorSamples: 0,
    sourceFrontier: null,
    clockCorrectionSamples: 0,
    resampleTail: [],
    resampleNextTargetSample: null,
  };
}

/** Forgets everything on the timeline, including the capture it was anchored to. */
export function resetPcmTimeline(timeline: PcmTimeline) {
  timeline.chunks = [];
  timeline.totalSamples = 0;
  timeline.generation = null;
  timeline.sourceRate = null;
  timeline.originOffset = 0;
  timeline.gapSamples = 0;
  timeline.unheadered = false;
  timeline.clockErrorSamples = 0;
  timeline.sourceFrontier = null;
  timeline.clockCorrectionSamples = 0;
  timeline.resampleTail = [];
  timeline.resampleNextTargetSample = null;
}

/**
 * Lengthen a proven-contiguous PCM span by exactly one sample without creating
 * a zero-order hold at the frame tail.
 *
 * The endpoints are preserved and the added time is distributed across the
 * whole span with linear interpolation. This is a tiny sample-rate trim, not a
 * content splice.
 */
export function stretchPcmSpanByOne(input: Int16Array) {
  if (input.length === 0) return new Int16Array(0);
  if (input.length === 1) return Int16Array.of(input[0], input[0]);

  const output = new Int16Array(input.length + 1);
  const sourceScale = (input.length - 1) / input.length;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * sourceScale;
    const left = Math.floor(position);
    const fraction = position - left;
    const a = input[left];
    const b = input[Math.min(left + 1, input.length - 1)];
    output[index] = Math.round(a + (b - a) * fraction);
  }
  return output;
}

/**
 * Shorten a proven-contiguous PCM span by exactly one sample, the mirror of
 * stretchPcmSpanByOne: endpoints kept, the removed time spread across the span.
 */
export function compressPcmSpanByOne(input: Int16Array) {
  if (input.length < 3) return input.slice();
  const output = new Int16Array(input.length - 1);
  const sourceScale = (input.length - 1) / (input.length - 2);
  for (let index = 0; index < output.length; index += 1) {
    const position = index * sourceScale;
    const left = Math.floor(position);
    const fraction = position - left;
    const a = input[left];
    const b = input[Math.min(left + 1, input.length - 1)];
    output[index] = Math.round(a + (b - a) * fraction);
  }
  return output;
}

export type ResampledPcm = {
  samples: Int16Array;
  targetStart: number | null;
  nextTargetSample: number | null;
  sourceAlignedSampleOffset: number;
};

/**
 * Converts one packet of 16-bit PCM to the mix rate.
 *
 * Positioned packets resample on the source's own clock, so consecutive
 * packets join without a seam: `previousSourceSamples` and `nextTargetSample`
 * carry the interpolation state across the packet boundary.
 */
export function resamplePcm(
  buffer: Buffer,
  sourceRate: number,
  targetRate: number,
  sourceFirstSampleIndex: number | null = null,
  previousSourceSamples: readonly number[] = [],
  nextTargetSample: number | null = null,
): ResampledPcm {
  const inputLength = Math.floor(buffer.byteLength / 2);
  if (inputLength <= 0) {
    return {
      samples: new Int16Array(0),
      targetStart: sourceFirstSampleIndex,
      nextTargetSample,
      sourceAlignedSampleOffset: 0,
    };
  }

  const positioned = sourceFirstSampleIndex !== null;
  if (sourceRate === targetRate) {
    const output = new Int16Array(inputLength);
    for (let i = 0; i < inputLength; i += 1) output[i] = buffer.readInt16LE(i * 2);
    return {
      samples: output,
      targetStart: positioned ? sourceFirstSampleIndex : null,
      nextTargetSample: positioned ? sourceFirstSampleIndex + inputLength : null,
      sourceAlignedSampleOffset: 0,
    };
  }

  if (!positioned) {
    // Legacy headerless PCM has no source-clock position, so there is no
    // cross-packet interpolation authority. Preserve its old packet-local
    // best effort rather than pretending continuity we cannot prove.
    const outputLength = Math.max(1, Math.round((inputLength * targetRate) / sourceRate));
    const output = new Int16Array(outputLength);
    const sourcePerTargetSample = sourceRate / targetRate;
    for (let i = 0; i < outputLength; i += 1) {
      const position = i * sourcePerTargetSample;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = buffer.readInt16LE(Math.min(index, inputLength - 1) * 2);
      const b = buffer.readInt16LE(Math.min(index + 1, inputLength - 1) * 2);
      output[i] = Math.round(a + (b - a) * fraction);
    }
    return {
      samples: output,
      targetStart: null,
      nextTargetSample: null,
      sourceAlignedSampleOffset: 0,
    };
  }

  const sourceStart = sourceFirstSampleIndex;
  const sourceEnd = sourceStart + inputLength;
  let targetIndex = nextTargetSample
    ?? Math.ceil((sourceStart * targetRate) / sourceRate);
  let firstEmittedTarget: number | null = null;
  const firstCurrentFrameTarget = Math.ceil((sourceStart * targetRate) / sourceRate);
  let sourceAlignedSampleOffset = 0;
  const emitted: number[] = [];

  const readAbsoluteSourceSample = (index: number) => {
    if (index < sourceStart && sourceStart - index <= previousSourceSamples.length) {
      return previousSourceSamples[previousSourceSamples.length - (sourceStart - index)]!;
    }
    if (index < sourceStart || index >= sourceEnd) return null;
    return buffer.readInt16LE((index - sourceStart) * 2);
  };

  // A target sample t represents source position t * sourceRate / mixRate,
  // interpolated with a 4-point cubic (Catmull-Rom) through the two source
  // samples around it and one more on each side. Linear interpolation is a
  // triangle filter: upsampling 44.1 kHz it took 1.5 dB off 10 kHz and
  // 3.1 dB off 15 kHz, where the cubic keeps them within 0.4 and 1.5 dB.
  // Emit t only once every tap past the packet end has arrived: the
  // contiguous next packet emits a pending t from the resample tail plus its
  // own first samples. This removes the 20 ms sample-hold seam without
  // inventing audio across a real source gap. An outer tap before the
  // capture began, or across a real gap, never arrives, so the edge sample
  // stands in for it.
  const safetyEnd = Math.ceil((sourceEnd * targetRate) / sourceRate) + 2;
  while (targetIndex <= safetyEnd) {
    const numerator = targetIndex * sourceRate;
    const sourceIndex = Math.floor(numerator / targetRate);
    const remainder = numerator - sourceIndex * targetRate;
    const a = readAbsoluteSourceSample(sourceIndex);

    if (a === null) {
      if (sourceIndex >= sourceEnd) break;
      targetIndex += 1;
      continue;
    }

    let value = a;
    if (remainder !== 0) {
      const b = readAbsoluteSourceSample(sourceIndex + 1);
      if (b === null) break;
      const c = readAbsoluteSourceSample(sourceIndex + 2);
      if (c === null && sourceIndex + 2 >= sourceEnd) break;
      const fraction = remainder / targetRate;
      const p0 = readAbsoluteSourceSample(sourceIndex - 1) ?? a;
      const p3 = c ?? b;
      value = a + 0.5 * fraction * (
        b - p0 + fraction * (
          2 * p0 - 5 * a + 4 * b - p3 + fraction * (3 * (a - b) + p3 - p0)
        )
      );
      // A cubic can overshoot its taps; Int16Array would wrap it.
      value = Math.max(-32_768, Math.min(32_767, value));
    }

    if (firstEmittedTarget === null) firstEmittedTarget = targetIndex;
    if (targetIndex < firstCurrentFrameTarget) sourceAlignedSampleOffset += 1;
    emitted.push(Math.round(value));
    targetIndex += 1;
  }

  return {
    samples: Int16Array.from(emitted),
    targetStart: firstEmittedTarget ?? targetIndex,
    nextTargetSample: targetIndex,
    sourceAlignedSampleOffset,
  };
}

function firstChunkAtOrBefore(timeline: PcmTimelineReadView, sampleIndex: number) {
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

/** The samples for a session range; anything missing reads as silence. */
export function readPcmRange(timeline: PcmTimelineReadView, startSample: number, count: number) {
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

  let chunkIndex = firstChunkAtOrBefore(timeline, cursor);
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

/**
 * Per-source-sample evidence, one bit set per SOURCE_* fact.
 *
 * Ordinary unity-rate mixing keeps the cheaper aggregate evidence readers.
 * A slew interpolates fractional source positions, so it needs evidence for
 * both interpolation endpoints from the exact source span it is reading.
 */
export function readPcmSourceEvidence(
  timeline: PcmTimelineReadView,
  startSample: number,
  count: number,
) {
  const mask = new Uint8Array(Math.max(0, count));
  let cursor = startSample;
  let remaining = count;
  let outputOffset = 0;

  if (remaining <= 0) return mask;
  if (cursor < 0) {
    const preRoll = Math.min(remaining, -cursor);
    cursor += preRoll;
    remaining -= preRoll;
    outputOffset += preRoll;
  }
  if (remaining <= 0) return mask;

  if (timeline.chunks.length === 0 || cursor >= timeline.totalSamples) {
    mask.fill(SOURCE_PAST_FRONTIER, outputOffset, outputOffset + remaining);
    return mask;
  }

  let chunkIndex = firstChunkAtOrBefore(timeline, cursor);
  while (remaining > 0) {
    if (cursor >= timeline.totalSamples || chunkIndex >= timeline.chunks.length) {
      mask.fill(SOURCE_PAST_FRONTIER, outputOffset, outputOffset + remaining);
      break;
    }

    const chunk = timeline.chunks[chunkIndex];
    const chunkEnd = chunk.start + chunk.samples.length;
    if (cursor >= chunkEnd) {
      chunkIndex += 1;
      continue;
    }

    if (cursor < chunk.start) {
      const missing = Math.min(
        remaining,
        chunk.start - cursor,
        timeline.totalSamples - cursor,
      );
      mask.fill(SOURCE_GAP, outputOffset, outputOffset + missing);
      cursor += missing;
      remaining -= missing;
      outputOffset += missing;
      continue;
    }

    const available = Math.min(remaining, chunkEnd - cursor);
    if (!chunk.positioned) {
      mask.fill(SOURCE_UNHEADERED, outputOffset, outputOffset + available);
    } else if (chunk.concealed) {
      mask.fill(SOURCE_CONCEALED, outputOffset, outputOffset + available);
    }
    cursor += available;
    remaining -= available;
    outputOffset += available;
    chunkIndex += 1;
  }

  return mask;
}

/**
 * Marks only proven internal positioned holes for the requested source range.
 * Frontier starvation is intentionally left unmarked: the mixer already knows
 * that trailing boundary from readPcmEvidence(). Structural pre-roll is neither.
 *
 * This is allocated only for frames whose aggregate evidence contains a gap,
 * keeping the ordinary hot path allocation-free.
 */
export function readPcmGapMask(timeline: PcmTimeline, startSample: number, count: number) {
  const mask = new Uint8Array(Math.max(0, count));
  let cursor = startSample;
  let remaining = count;
  let outputOffset = 0;

  if (remaining <= 0) return mask;
  if (cursor < 0) {
    const preRoll = Math.min(remaining, -cursor);
    cursor += preRoll;
    remaining -= preRoll;
    outputOffset += preRoll;
  }
  if (
    remaining <= 0
    || timeline.chunks.length === 0
    || cursor >= timeline.totalSamples
  ) return mask;

  let chunkIndex = firstChunkAtOrBefore(timeline, cursor);
  while (remaining > 0 && cursor < timeline.totalSamples) {
    if (chunkIndex >= timeline.chunks.length) break;

    const chunk = timeline.chunks[chunkIndex];
    const chunkEnd = chunk.start + chunk.samples.length;
    if (cursor >= chunkEnd) {
      chunkIndex += 1;
      continue;
    }

    if (cursor < chunk.start) {
      const missing = Math.min(
        remaining,
        chunk.start - cursor,
        timeline.totalSamples - cursor,
      );
      mask.fill(1, outputOffset, outputOffset + missing);
      cursor += missing;
      remaining -= missing;
      outputOffset += missing;
      continue;
    }

    const available = Math.min(remaining, chunkEnd - cursor);
    cursor += available;
    remaining -= available;
    outputOffset += available;
    chunkIndex += 1;
  }

  return mask;
}

/**
 * Describes missing/legacy source samples for exactly the requested output
 * range. Silence before session sample zero is structural pre-roll and is not
 * counted as a source failure. Missing samples inside an established frontier
 * are gaps; samples beyond the frontier are starvation/unavailability.
 */
export function readPcmEvidence(timeline: PcmTimeline, startSample: number, count: number): PcmEvidence {
  let cursor = startSample;
  let remaining = count;
  let gapSamples = 0;
  let frontierMissingSamples = 0;
  let unheaderedSamples = 0;

  if (remaining <= 0) return { gapSamples, frontierMissingSamples, unheaderedSamples };
  if (cursor < 0) {
    const preRoll = Math.min(remaining, -cursor);
    cursor += preRoll;
    remaining -= preRoll;
  }
  if (remaining <= 0) return { gapSamples, frontierMissingSamples, unheaderedSamples };

  if (timeline.chunks.length === 0 || cursor >= timeline.totalSamples) {
    frontierMissingSamples += remaining;
    return { gapSamples, frontierMissingSamples, unheaderedSamples };
  }

  let chunkIndex = firstChunkAtOrBefore(timeline, cursor);
  while (remaining > 0) {
    if (cursor >= timeline.totalSamples || chunkIndex >= timeline.chunks.length) {
      frontierMissingSamples += remaining;
      break;
    }

    const chunk = timeline.chunks[chunkIndex];
    const chunkEnd = chunk.start + chunk.samples.length;
    if (cursor >= chunkEnd) {
      chunkIndex += 1;
      continue;
    }

    if (cursor < chunk.start) {
      const missing = Math.min(remaining, chunk.start - cursor);
      gapSamples += missing;
      cursor += missing;
      remaining -= missing;
      continue;
    }

    const available = Math.min(remaining, chunkEnd - cursor);
    if (!chunk.positioned) unheaderedSamples += available;
    // Concealment is audible fill, not received audio.
    if (chunk.concealed) gapSamples += available;
    cursor += available;
    remaining -= available;
    chunkIndex += 1;
  }

  return { gapSamples, frontierMissingSamples, unheaderedSamples };
}

/**
 * Drops whole chunks that end before `beforeSample`. The newest chunk always
 * stays: it carries the frontier the next packet is placed against.
 */
export function trimPcmTimeline(timeline: PcmTimeline, beforeSample: number) {
  while (timeline.chunks.length > 1) {
    const chunk = timeline.chunks[0];
    if (chunk.start + chunk.samples.length >= beforeSample) break;
    timeline.chunks.shift();
  }
}

/** Whether retained PCM still lies ahead of this read position. */
export function retainsPcmAfter(timeline: PcmTimeline, sourceSample: number) {
  return timeline.chunks.length > 0 && timeline.totalSamples > sourceSample;
}
