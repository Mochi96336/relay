export const MIC_PRESENCE_BAND_COUNT = 5;
export const MIC_PRESENCE_MIN_F0_HZ = 80;
export const MIC_PRESENCE_MAX_F0_HZ = 1000;

export type MicPresenceTelemetry = {
  version: 1;
  captureGeneration: number;
  rmsDbfs: number;
  spectrumBands: [number, number, number, number, number];
  f0Hz: number | null;
  pitchConfidence: number;
};

export function parseMicPresenceTelemetry(value: unknown): MicPresenceTelemetry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (Number(payload.version) !== 1) return null;

  const captureGeneration = Number(payload.captureGeneration);
  const rmsDbfs = Number(payload.rmsDbfs);
  const rawBands = payload.spectrumBands;
  const rawF0Hz = payload.f0Hz;
  const pitchConfidence = Number(payload.pitchConfidence);
  if (
    !Number.isInteger(captureGeneration)
    || captureGeneration < 0
    || captureGeneration > 0xffff_ffff
    || !Number.isFinite(rmsDbfs)
    || rmsDbfs < -120
    || rmsDbfs > 0
    || !Array.isArray(rawBands)
    || rawBands.length !== MIC_PRESENCE_BAND_COUNT
    || !Number.isFinite(pitchConfidence)
    || pitchConfidence < 0
    || pitchConfidence > 1
  ) return null;

  let f0Hz: number | null = null;
  if (rawF0Hz !== null) {
    f0Hz = Number(rawF0Hz);
    if (
      !Number.isFinite(f0Hz)
      || f0Hz < MIC_PRESENCE_MIN_F0_HZ
      || f0Hz > MIC_PRESENCE_MAX_F0_HZ
    ) return null;
  }

  const spectrumBands = rawBands.map(Number);
  if (spectrumBands.some((band) => !Number.isFinite(band) || band < 0 || band > 1)) return null;

  return {
    version: 1,
    captureGeneration: captureGeneration >>> 0,
    rmsDbfs,
    spectrumBands: spectrumBands as MicPresenceTelemetry['spectrumBands'],
    f0Hz,
    pitchConfidence,
  };
}
