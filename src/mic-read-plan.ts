/** Scalar snapshot in mix-rate session-timeline coordinates, after authority updates. */
export type MicReadMotionInput = {
  frameSamples: number;
  sampleRate: number;
  startSample: number;
  previouslyEmittedAdvanceSamples: number | null;
  previousAdvanceSamplesExact: number;
  lastEmittedMicFrameComplete: boolean;
  appliedAdvanceMs: number;
  runtimeCalibrationSlewFraction: number;
  readHeadCrossfadeMs: number;
};

/** Classifies motion only; no clock, history, authority or evidence is mutated. */
export function classifyMicReadMotion(input: MicReadMotionInput) {
  const {
    frameSamples, sampleRate, startSample, previouslyEmittedAdvanceSamples,
    previousAdvanceSamplesExact, lastEmittedMicFrameComplete, appliedAdvanceMs,
    runtimeCalibrationSlewFraction, readHeadCrossfadeMs,
  } = input;
  const advanceSamplesExact = (appliedAdvanceMs * sampleRate) / 1000;
  const advanceSamples = Math.round(advanceSamplesExact);
  const micReadStart = startSample + advanceSamples;
  // Calibration and frontier release can both move at the existing bound.
  const maximumBoundedRuntimeDeltaSamples =
    (2 * frameSamples * runtimeCalibrationSlewFraction) + 1;
  const runtimeAdvanceDeltaSamples = advanceSamplesExact - previousAdvanceSamplesExact;
  const boundedRuntimeAdvanceMoved = Math.abs(runtimeAdvanceDeltaSamples) > 1e-9
    && Math.abs(runtimeAdvanceDeltaSamples) <= maximumBoundedRuntimeDeltaSamples;
  const immediateReadHeadJump = previouslyEmittedAdvanceSamples !== null
    && lastEmittedMicFrameComplete
    && Math.abs(advanceSamples - previouslyEmittedAdvanceSamples)
      > maximumBoundedRuntimeDeltaSamples;
  const crossfadeSamples = Math.min(
    frameSamples,
    Math.max(2, Math.round((readHeadCrossfadeMs * sampleRate) / 1000)),
  );
  const previousTransitionStart = previouslyEmittedAdvanceSamples === null
    ? 0
    : Math.floor(startSample + previouslyEmittedAdvanceSamples);
  const readHeadJumped = previouslyEmittedAdvanceSamples !== null
    && Math.abs(advanceSamples - previouslyEmittedAdvanceSamples)
      > maximumBoundedRuntimeDeltaSamples;
  return {
    advanceSamplesExact, advanceSamples, micReadStart,
    maximumBoundedRuntimeDeltaSamples, boundedRuntimeAdvanceMoved,
    immediateReadHeadJump, crossfadeSamples, previousTransitionStart, readHeadJumped,
  };
}
