import type { CaptureRestartBoundaries } from './capture-restart-boundaries.js';
import type { MicInputClipping } from './mic-input-clipping.js';
import {
  readPcmRange, readPcmSourceEvidence, SOURCE_CONCEALED, SOURCE_GAP,
  SOURCE_PAST_FRONTIER, SOURCE_UNHEADERED, type PcmEvidence, type PcmTimelineReadView,
} from './pcm-timeline.js';

/** PCM, evidence and clipping from exactly one fractional emitted trajectory. */
export type MicSlewRead = {
  samples: Int16Array<ArrayBuffer>;
  evidence: PcmEvidence;
  missingMask: Uint8Array;
  inputClippingMask: Uint8Array | null;
  firstPosition: number;
  rate: number;
};

export type MicSlewReadInput = {
  timeline: PcmTimelineReadView;
  frameSamples: number;
  startSample: number;
  fromAdvanceSamples: number;
  toAdvanceSamples: number;
  lookaheadSamples: number;
  inputClipping: Pick<MicInputClipping, 'empty' | 'at'>;
  captureRestartBoundaries: Pick<CaptureRestartBoundaries, 'has'>;
};

/**
 * Reads only: source identity, retention, resets and output edges stay in the
 * caller. The limiter tail resumes unity rate after the frame's exact landing.
 */
export function readMicSlewedRange(input: MicSlewReadInput): MicSlewRead {
  const {
    timeline, frameSamples, startSample, fromAdvanceSamples, toAdvanceSamples,
    lookaheadSamples, inputClipping, captureRestartBoundaries,
  } = input;
  const total = frameSamples + lookaheadSamples;
  const output = new Int16Array(total);
  const rate = 1 + ((toAdvanceSamples - fromAdvanceSamples) / frameSamples);

  const firstPosition = startSample + fromAdvanceSamples;
  const frameEndPosition = startSample + frameSamples + toAdvanceSamples;
  const lastPosition = frameEndPosition + Math.max(0, lookaheadSamples - 1);
  const sourceStart = Math.floor(Math.min(firstPosition, frameEndPosition, lastPosition));
  const sourceEnd = Math.ceil(Math.max(firstPosition, frameEndPosition, lastPosition)) + 2;
  const sourceCount = Math.max(0, sourceEnd - sourceStart);
  const source = readPcmRange(timeline, sourceStart, sourceCount);
  const sourceEvidence = readPcmSourceEvidence(timeline, sourceStart, sourceCount);
  const missingMask = new Uint8Array(frameSamples);
  const inputClippingMask = !inputClipping.empty
    ? new Uint8Array(frameSamples)
    : null;
  const crossesCaptureRestartBoundary = (sourceIndex: number) => (
    captureRestartBoundaries.has(sourceIndex + 1)
  );
  let gapSamples = 0;
  let frontierMissingSamples = 0;
  let unheaderedSamples = 0;

  const interpolate = (position: number) => {
    const index = Math.floor(position);
    const fraction = position - index;
    const offset = index - sourceStart;
    const a = source[offset] ?? 0;
    // A capture restart is a semantic discontinuity, not an interpolation
    // authority. Stay on the old side until the fractional read trajectory
    // actually reaches the new capture; the existing output replacement fade
    // owns continuity across that boundary.
    const b = fraction !== 0 && crossesCaptureRestartBoundary(index)
      ? a
      : source[offset + 1] ?? a;
    return Math.round(a + (b - a) * fraction);
  };

  for (let i = 0; i < frameSamples; i += 1) {
    const position = firstPosition + i * rate;
    const index = Math.floor(position);
    const fraction = position - index;
    const offset = index - sourceStart;
    let evidence = sourceEvidence[offset] ?? SOURCE_PAST_FRONTIER;
    // Interpolation normally consumes both source samples. A semantic
    // capture-restart edge deliberately does not: audio stays on the old side
    // until the source trajectory crosses the boundary, so evidence must do
    // the same.
    if (fraction !== 0 && !crossesCaptureRestartBoundary(index)) {
      evidence |= sourceEvidence[offset + 1] ?? SOURCE_PAST_FRONTIER;
    }

    if ((evidence & SOURCE_PAST_FRONTIER) !== 0) frontierMissingSamples += 1;
    // Concealment counts as a gap, but it is audible, so it is not missing.
    else if ((evidence & (SOURCE_GAP | SOURCE_CONCEALED)) !== 0) gapSamples += 1;
    if ((evidence & SOURCE_UNHEADERED) !== 0) unheaderedSamples += 1;
    if ((evidence & (SOURCE_GAP | SOURCE_PAST_FRONTIER)) !== 0) missingMask[i] = 1;
    if (inputClippingMask) {
      let clipped = inputClipping.at(index);
      if (fraction !== 0 && !crossesCaptureRestartBoundary(index)) {
        clipped ||= inputClipping.at(index + 1);
      }
      if (clipped) inputClippingMask[i] = 1;
    }

    output[i] = interpolate(position);
  }
  for (let i = 0; i < lookaheadSamples; i += 1) {
    output[frameSamples + i] = interpolate(frameEndPosition + i);
  }
  return {
    samples: output,
    evidence: { gapSamples, frontierMissingSamples, unheaderedSamples },
    missingMask,
    inputClippingMask,
    firstPosition,
    rate,
  };
}

export type MicReadHeadCrossfadeInput = {
  timeline: PcmTimelineReadView;
  frameSamples: number;
  sampleRate: number;
  readHeadCrossfadeMs: number;
  startSample: number;
  fromAdvanceSamples: number;
  toStartSample: number;
  previousSourceSample: number | null;
  current: Int16Array<ArrayBuffer>;
  inputClipping: Pick<MicInputClipping, 'at'>;
  captureRestartBoundaries: Pick<CaptureRestartBoundaries, 'firstForwardCrossing'>;
};

/**
 * Mutates caller-owned current PCM, never retained chunks. The caller must
 * prove real PCM on both legs; the old leg holds at a forward-only capture seam.
 */
export function crossfadeMicReadHeadJump(input: MicReadHeadCrossfadeInput) {
  const {
    timeline, frameSamples, sampleRate, readHeadCrossfadeMs, startSample,
    fromAdvanceSamples, toStartSample, previousSourceSample, current,
    inputClipping, captureRestartBoundaries,
  } = input;
  const crossfadeSamples = Math.min(
    frameSamples,
    Math.max(2, Math.round((readHeadCrossfadeMs * sampleRate) / 1000)),
  );
  const firstPosition = startSample + fromAdvanceSamples;
  const oldLegEnd = firstPosition + crossfadeSamples + 1;
  const restartBoundary = previousSourceSample === null
    ? null
    : captureRestartBoundaries.firstForwardCrossing(previousSourceSample, oldLegEnd);
  const holdSourceSample = restartBoundary === null ? null : restartBoundary - 1;
  const sourceStart = Math.floor(Math.min(
    firstPosition,
    holdSourceSample ?? firstPosition,
  ));
  const sourceEnd = Math.ceil(oldLegEnd) + 1;
  const sourceCount = Math.max(0, sourceEnd - sourceStart);
  const source = readPcmRange(timeline, sourceStart, sourceCount);
  const sourceEvidence = readPcmSourceEvidence(timeline, sourceStart, sourceCount);
  const newLegEvidence = readPcmSourceEvidence(timeline, toStartSample, crossfadeSamples);
  const heldOldSample = holdSourceSample === null
    ? null
    : source[holdSourceSample - sourceStart] ?? 0;
  const heldOldEvidence = holdSourceSample === null
    ? 0
    : sourceEvidence[holdSourceSample - sourceStart] ?? 0;

  const evidenceAt = (position: number) => {
    if (
      restartBoundary !== null
      && position >= restartBoundary
    ) {
      return heldOldEvidence;
    }
    const index = Math.floor(position);
    const fraction = position - index;
    const offset = index - sourceStart;
    let evidence = sourceEvidence[offset] ?? 0;
    if (
      fraction !== 0
      && !(
        restartBoundary !== null
        && index < restartBoundary
        && restartBoundary <= index + 1
      )
    ) {
      evidence |= sourceEvidence[offset + 1] ?? 0;
    }
    return evidence;
  };

  const interpolate = (position: number) => {
    if (
      restartBoundary !== null
      && heldOldSample !== null
      && position >= restartBoundary
    ) {
      // The old crossfade leg has reached a semantic capture boundary. It is
      // only continuity history for fading out the previous read trajectory,
      // so never let it enter the replacement capture. Hold the last old
      // sample while its weight falls to zero; the authoritative new
      // trajectory will cross that boundary later under the normal
      // replacement-edge state machine if it actually needs to.
      return heldOldSample;
    }

    const index = Math.floor(position);
    const fraction = position - index;
    const offset = index - sourceStart;
    const a = source[offset] ?? 0;
    const b = restartBoundary !== null
      && index < restartBoundary
      && restartBoundary <= index + 1
      ? a
      : source[offset + 1] ?? a;
    return a + (b - a) * fraction;
  };

  let actualCrossfadeUnheaderedSamples = 0;
  let newLegCrossfadeUnheaderedSamples = 0;
  let actualCrossfadeInputClippedSamples = 0;
  let newLegCrossfadeInputClippedSamples = 0;
  for (let i = 0; i < crossfadeSamples; i += 1) {
    const newWeight = crossfadeSamples === 1 ? 1 : i / (crossfadeSamples - 1);
    const oldWeight = 1 - newWeight;
    const oldPosition = firstPosition + i;
    const oldSample = interpolate(oldPosition);
    const oldUnheadered = (evidenceAt(oldPosition) & SOURCE_UNHEADERED) !== 0;
    const newUnheadered = ((newLegEvidence[i] ?? 0) & SOURCE_UNHEADERED) !== 0;

    const oldClippingPosition = (
      restartBoundary !== null
      && holdSourceSample !== null
      && oldPosition >= restartBoundary
    ) ? holdSourceSample : oldPosition;
    const oldIndex = Math.floor(oldClippingPosition);
    const oldFraction = oldClippingPosition - oldIndex;
    let oldInputClipped = inputClipping.at(oldIndex);
    if (
      oldFraction !== 0
      && !(
        restartBoundary !== null
        && oldIndex < restartBoundary
        && restartBoundary <= oldIndex + 1
      )
    ) {
      oldInputClipped ||= inputClipping.at(oldIndex + 1);
    }
    const newInputClipped = inputClipping.at(toStartSample + i);

    if (newUnheadered) newLegCrossfadeUnheaderedSamples += 1;
    if (newInputClipped) newLegCrossfadeInputClippedSamples += 1;
    if (
      (oldWeight > 0 && oldUnheadered)
      || (newWeight > 0 && newUnheadered)
    ) {
      actualCrossfadeUnheaderedSamples += 1;
    }
    if (
      (oldWeight > 0 && oldInputClipped)
      || (newWeight > 0 && newInputClipped)
    ) {
      actualCrossfadeInputClippedSamples += 1;
    }
    current[i] = Math.round(oldSample * oldWeight + current[i] * newWeight);
  }
  return {
    samples: current,
    unheaderedSamplesDelta:
      actualCrossfadeUnheaderedSamples - newLegCrossfadeUnheaderedSamples,
    inputClippedSamplesDelta:
      actualCrossfadeInputClippedSamples - newLegCrossfadeInputClippedSamples,
  };
}

