import type { MixFramePosition } from './audio-session.js';

export type TakeFrameBoundary = {
  position: MixFramePosition;
  /** Monotonic server time represented by the addressed mix-frame start. */
  atMs: number;
};

/**
 * Maps a command instant onto the first complete mix frame that starts at or
 * after that instant on AudioSession's authoritative sample clock.
 *
 * The mixer may be emitting `prebufferMs` behind real time; that delay is
 * deliberately irrelevant here. `sessionSampleIndex` may be fractional because
 * command time must not be rounded backward before frame quantization. The
 * returned MixFramePosition is still an exact integer frame address.
 */
export function takeFrameBoundaryAtOrAfter(input: {
  generation: number;
  sessionSampleIndex: number;
  frameSamples: number;
  sampleRate: number;
  nowMs: number;
}): TakeFrameBoundary {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('Take boundary mix generation is invalid.');
  }
  if (!Number.isFinite(input.sessionSampleIndex)) {
    throw new Error('Take boundary session sample is invalid.');
  }
  if (!Number.isSafeInteger(input.frameSamples) || input.frameSamples <= 0) {
    throw new Error('Take boundary frame size is invalid.');
  }
  if (!Number.isFinite(input.sampleRate) || input.sampleRate <= 0) {
    throw new Error('Take boundary sample rate is invalid.');
  }
  if (!Number.isFinite(input.nowMs)) {
    throw new Error('Take boundary command time is invalid.');
  }

  const commandSampleIndex = Math.max(0, input.sessionSampleIndex);
  const frameIndex = Math.ceil(commandSampleIndex / input.frameSamples);
  const firstSampleIndex = frameIndex * input.frameSamples;
  if (!Number.isSafeInteger(firstSampleIndex)) {
    throw new Error('Take boundary sample position exceeds the safe integer range.');
  }

  const deltaSamples = firstSampleIndex - commandSampleIndex;
  return {
    position: {
      generation: input.generation,
      firstSampleIndex,
    },
    atMs: input.nowMs + (deltaSamples / input.sampleRate) * 1_000,
  };
}
