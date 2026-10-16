/**
 * Shared singer-local alignment decision contract.
 *
 * The live canonical MicTrack and room authority gates use this type
 * without importing the first-generation synchronous calibration model.
 * Content, Sample and Boot evidence remain distinct; no source is
 * promoted by declaring a type alone.
 */
export type ChoirCalibrationSource =
  | 'content' | 'content-held' | 'sample-song-estimate'
  | 'boot-probe-estimate' | 'unavailable';

export type ChoirAlignmentDecision = {
  source: ChoirCalibrationSource;
  advanceMs: number | null;
  /** Relative to confirmed Content only when that evidence is applicable. */
  sampleResidualMs: number | null;
  bootResidualMs: number | null;
  sampleCandidateMs: number | null;
  bootCandidateMs: number | null;
};
