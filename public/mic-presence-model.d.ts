export const MIC_PRESENCE_SLICE_COUNT: number;
export const MIC_PRESENCE_BAND_COUNT: number;
export const MIC_PRESENCE_MIN_DBFS: number;
export const MIC_PRESENCE_MAX_DBFS: number;

export type MicPresenceSlice = {
  presence: number;
  bands: number[];
};

export function rmsDbfsToPresence(rmsDbfs: number): number;
export function normalizeSpectrumBands(spectrumBands: unknown): number[];
export function createPresenceSlice(rmsDbfs: number, spectrumBands: unknown): MicPresenceSlice;
export function emptyPresenceSlice(): MicPresenceSlice;
export function nextPresenceHistory(
  history: MicPresenceSlice[],
  rmsDbfs: number,
  spectrumBands: unknown,
  count?: number,
): MicPresenceSlice[];
