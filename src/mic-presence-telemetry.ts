export const MIC_PRESENCE_BAND_COUNT = 5;

export type MicPresenceTelemetry = {
  version: 1;
  captureGeneration: number;
  rmsDbfs: number;
  spectrumBands: [number, number, number, number, number];
};

function uint32(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0xffff_ffff
    ? number >>> 0
    : null;
}

export function parseMicPresenceTelemetry(value: unknown): MicPresenceTelemetry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Number(payload.version) !== 1) return null;

  const captureGeneration = uint32(payload.captureGeneration);
  const rmsDbfs = Number(payload.rmsDbfs);
  const rawBands = payload.spectrumBands;
  if (
    captureGeneration === null
    || !Number.isFinite(rmsDbfs)
    || rmsDbfs < -120
    || rmsDbfs > 0
    || !Array.isArray(rawBands)
    || rawBands.length !== MIC_PRESENCE_BAND_COUNT
  ) return null;

  const spectrumBands = rawBands.map(Number);
  if (spectrumBands.some((band) => !Number.isFinite(band) || band < 0 || band > 1)) return null;

  return {
    version: 1,
    captureGeneration,
    rmsDbfs,
    spectrumBands: spectrumBands as MicPresenceTelemetry['spectrumBands'],
  };
}
