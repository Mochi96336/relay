/**
 * Experimental, pure song-position read planner for independent singer tracks.
 *
 * An anchor says that a particular room sample position corresponds to a
 * particular sample in ONE singer's capture. An acoustic Content result must
 * first be translated into such an anchor; this code does not perform Content
 * matching, schedule capture, or make late PCM arrive sooner.
 *
 * In the first prototype a song epoch has constant playback rate. A seek,
 * song/rate change, mic capture restart, or backing restart must retire the
 * anchor before it can drive a mixer read.
 */
export type ChoirTrackAnchor = {
  participantId: string;
  songEpoch: number;
  captureGeneration: number;
  backingGeneration: number;
  roomSampleAtAnchor: number;
  micSampleAtAnchor: number;
  roomSampleRate: number;
  micSampleRate: number;
};

export type ChoirReadRequest = {
  participantId: string;
  songEpoch: number;
  captureGeneration: number;
  backingGeneration: number;
  roomStartSample: number;
  frameSamples: number;
};

export type ChoirReadPlan = {
  micFirstSample: number;
  micStep: number;
  frameSamples: number;
};

function epoch(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** Returns null rather than reading a stale singer/recording/song generation. */
export function planChoirRead(
  anchor: ChoirTrackAnchor,
  request: ChoirReadRequest,
): ChoirReadPlan | null {
  if (
    anchor.participantId.length === 0
    || anchor.participantId !== request.participantId
    || !epoch(anchor.songEpoch) || anchor.songEpoch !== request.songEpoch
    || !epoch(anchor.captureGeneration) || anchor.captureGeneration !== request.captureGeneration
    || !epoch(anchor.backingGeneration) || anchor.backingGeneration !== request.backingGeneration
    || !epoch(anchor.roomSampleAtAnchor)
    || !Number.isFinite(anchor.micSampleAtAnchor)
    || !Number.isFinite(anchor.roomSampleRate) || anchor.roomSampleRate <= 0
    || !Number.isFinite(anchor.micSampleRate) || anchor.micSampleRate <= 0
    || !epoch(request.roomStartSample)
    || !epoch(request.frameSamples) || request.frameSamples === 0
  ) return null;

  // Both clocks are expressed in samples of the same physical elapsed time.
  // The anchor absorbs the fixed path difference established by Content.
  const micStep = anchor.micSampleRate / anchor.roomSampleRate;
  const micFirstSample = anchor.micSampleAtAnchor
    + (request.roomStartSample - anchor.roomSampleAtAnchor) * micStep;
  if (!Number.isFinite(micStep) || !Number.isFinite(micFirstSample)) return null;
  return { micFirstSample, micStep, frameSamples: request.frameSamples };
}
