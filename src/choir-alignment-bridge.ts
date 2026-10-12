import type {
  ChoirAlignmentDecision,
  ChoirCalibrationSource,
} from './choir-calibration-experiment.js';
import type { ChoirTrackAnchor } from './choir-read-plan.js';

/**
 * Takes an explicitly accepted room-space alignment and an independently
 * established mapping from room samples to *native Mic samples* at zero advance.
 *
 * The conversion of session-index to native-index must be supplied by the
 * capture/clock layer, not guessed from YouTube currentTime or packet arrival.
 * Neither the calibration result nor this helper can prove that mapping.
 */
export function choirAnchorFromDecision(input: {
  participantId: string;
  songEpoch: number;
  captureGeneration: number;
  backingGeneration: number;
  roomSampleRate: number;
  micSampleRate: number;
  roomSampleAtAnchor: number;
  zeroAdvanceNativeMicSample: number;
  decision: ChoirAlignmentDecision;
}): { anchor: ChoirTrackAnchor; source: ChoirCalibrationSource } | null {
  const { decision } = input;
  if (
    decision.source === 'unavailable' || decision.source === 'content-held'
    || decision.advanceMs === null || !Number.isFinite(decision.advanceMs)
    || !Number.isFinite(input.zeroAdvanceNativeMicSample)
    || !Number.isSafeInteger(input.roomSampleAtAnchor) || input.roomSampleAtAnchor < 0
    || !Number.isFinite(input.roomSampleRate) || input.roomSampleRate <= 0
    || !Number.isFinite(input.micSampleRate) || input.micSampleRate <= 0
    || !Number.isSafeInteger(input.songEpoch) || input.songEpoch < 0
    || !Number.isSafeInteger(input.captureGeneration) || input.captureGeneration < 0
    || !Number.isSafeInteger(input.backingGeneration) || input.backingGeneration < 0
    || !input.participantId
  ) return null;

  const micSampleAtAnchor = input.zeroAdvanceNativeMicSample
    + decision.advanceMs * input.micSampleRate / 1_000;
  if (!Number.isFinite(micSampleAtAnchor)) return null;
  return {
    source: decision.source,
    anchor: {
      participantId: input.participantId,
      songEpoch: input.songEpoch,
      captureGeneration: input.captureGeneration,
      backingGeneration: input.backingGeneration,
      roomSampleAtAnchor: input.roomSampleAtAnchor,
      micSampleAtAnchor,
      roomSampleRate: input.roomSampleRate,
      micSampleRate: input.micSampleRate,
    },
  };
}
