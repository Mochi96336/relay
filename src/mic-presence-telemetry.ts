export const MIC_PRESENCE_BAND_COUNT = 5;

export type MicPresenceTelemetry = {
  version: 1;
  rmsDbfs: number;
  spectrumBands: [number, number, number, number, number];
};

export function parseMicPresenceTelemetry(value: unknown): MicPresenceTelemetry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Number(payload.version) !== 1) return null;

  const rmsDbfs = Number(payload.rmsDbfs);
  const rawBands = payload.spectrumBands;
  if (
    !Number.isFinite(rmsDbfs)
    || rmsDbfs < -120
    || rmsDbfs > 0
    || !Array.isArray(rawBands)
    || rawBands.length !== MIC_PRESENCE_BAND_COUNT
  ) return null;

  const spectrumBands = rawBands.map(Number);
  if (spectrumBands.some((band) => !Number.isFinite(band) || band < 0 || band > 1)) return null;

  return {
    version: 1,
    rmsDbfs,
    spectrumBands: spectrumBands as MicPresenceTelemetry['spectrumBands'],
  };
}
