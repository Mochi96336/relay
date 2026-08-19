export const MIC_PRESENCE_SLICE_COUNT: number;
export const MIC_PRESENCE_BAND_COUNT: number;
export const MIC_PRESENCE_MIN_DBFS: number;
export const MIC_PRESENCE_MAX_DBFS: number;
export const MIC_PRESENCE_MIN_F0_HZ: number;
export const MIC_PRESENCE_MAX_F0_HZ: number;

export type MicPresenceSlice = {
  presence: number;
  bands: number[];
  f0Hz: number | null;
  pitchConfidence: number;
};

export type MicPresenceGeometry = {
  amplitude: number;
  density: number;
  pitchStrength: number;
  intensity: number;
};

export function rmsDbfsToPresence(rmsDbfs: number): number;
export function normalizeSpectrumBands(spectrumBands: unknown): number[];
export function normalizeF0Hz(f0Hz: unknown): number | null;
export function normalizePitchConfidence(pitchConfidence: unknown): number;
export function pitchLobeCount(f0Hz: unknown): number;
export function pitchTextureStrength(f0Hz: unknown, pitchConfidence: unknown): number;
export function createPresenceSlice(
  rmsDbfs: number,
  spectrumBands: unknown,
  f0Hz?: number | null,
  pitchConfidence?: number,
): MicPresenceSlice;
export function emptyPresenceSlice(): MicPresenceSlice;
export function presenceSliceGeometry(slice: MicPresenceSlice): MicPresenceGeometry;
export function centerOriginX(
  index: number,
  count?: number,
  width?: number,
): { left: number; right: number };
export function nextPresenceHistory(
  history: MicPresenceSlice[],
  rmsDbfs: number,
  spectrumBands: unknown,
  f0Hz?: number | null,
  pitchConfidence?: number,
  count?: number,
): MicPresenceSlice[];
