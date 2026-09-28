export type MicPresenceDisplayValues = {
  rmsDbfs: number;
  spectrumBands: number[];
  f0Hz: number | null;
  pitchConfidence: number;
};

export function micPresenceDisplayValues(values: MicPresenceDisplayValues): MicPresenceDisplayValues;
