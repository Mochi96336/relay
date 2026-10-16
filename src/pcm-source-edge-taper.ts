import type { PcmChunk } from './pcm-timeline.js';

/** Shared, byte-preserving source-gap tapers for Mic and backing captures. */
export function fadeOutSourceEdge(previous: Int16Array, sourceEdgeFadeSamples: number) {
  const fadeOutSamples = Math.min(sourceEdgeFadeSamples, previous.length);
  for (let offset = 0; offset < fadeOutSamples; offset += 1) {
    const index = previous.length - fadeOutSamples + offset;
    const weight = fadeOutSamples <= 1
      ? 0
      : (fadeOutSamples - 1 - offset) / (fadeOutSamples - 1);
    previous[index] = Math.round(previous[index] * weight);
  }
}

export function fadeInSourceEdge(next: Int16Array, sourceEdgeFadeSamples: number) {
  const fadeInSamples = Math.min(sourceEdgeFadeSamples, next.length);
  for (let index = 0; index < fadeInSamples; index += 1) {
    const weight = fadeInSamples <= 1 ? 0 : index / (fadeInSamples - 1);
    next[index] = Math.round(next[index] * weight);
  }
}

/** A proven PCM hole remains silence; only its real neighboring samples taper. */
export function declickSourceGap(
  previous: PcmChunk,
  next: Int16Array,
  firstUnheardSample: number,
  sourceEdgeFadeSamples: number,
) {
  const taper = Math.min(sourceEdgeFadeSamples, previous.samples.length);
  const previousEnd = previous.start + previous.samples.length;
  if (previousEnd - Math.max(previous.start, firstUnheardSample) >= taper) {
    fadeOutSourceEdge(previous.samples, sourceEdgeFadeSamples);
  }
  fadeInSourceEdge(next, sourceEdgeFadeSamples);
}
