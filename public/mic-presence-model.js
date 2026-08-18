export const MIC_PRESENCE_SLICE_COUNT = 10;
export const MIC_PRESENCE_BAND_COUNT = 5;
export const MIC_PRESENCE_MIN_DBFS = -58;
export const MIC_PRESENCE_MAX_DBFS = -18;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function rmsDbfsToPresence(rmsDbfs) {
  const value = Number(rmsDbfs);
  if (!Number.isFinite(value)) return 0;
  const normalized = clamp(
    (value - MIC_PRESENCE_MIN_DBFS) / (MIC_PRESENCE_MAX_DBFS - MIC_PRESENCE_MIN_DBFS),
    0,
    1,
  );
  return Math.pow(normalized, 0.72);
}

export function normalizeSpectrumBands(spectrumBands) {
  if (!Array.isArray(spectrumBands)) return Array(MIC_PRESENCE_BAND_COUNT).fill(0);
  // Preserve the relative energy before normalization. Clamping each raw band
  // to 1 first would flatten a real [1, 2] contrast into [1, 1].
  const safe = Array.from({ length: MIC_PRESENCE_BAND_COUNT }, (_, index) => {
    const value = Number(spectrumBands[index]);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const strongest = Math.max(...safe);
  if (strongest <= 0) return safe;
  return safe.map((value) => clamp(value / strongest, 0, 1));
}

export function createPresenceSlice(rmsDbfs, spectrumBands) {
  const presence = rmsDbfsToPresence(rmsDbfs);
  const shape = normalizeSpectrumBands(spectrumBands);
  return {
    presence,
    // RMS owns how strong the whole slice feels. The spectrum only shapes that
    // strength vertically, so a bright vowel does not look "louder" merely
    // because it has more high-frequency energy.
    bands: shape.map((band) => presence <= 0 ? 0 : presence * (0.12 + 0.88 * band)),
  };
}

export function emptyPresenceSlice() {
  return { presence: 0, bands: Array(MIC_PRESENCE_BAND_COUNT).fill(0) };
}

/**
 * Oldest slice stays on the left; the newest local Mic evidence enters on the
 * right. Ten samples at the UI's 40 ms cadence retain about 400 ms of sound.
 */
export function nextPresenceHistory(
  history,
  rmsDbfs,
  spectrumBands,
  count = MIC_PRESENCE_SLICE_COUNT,
) {
  const safeCount = Math.max(1, Math.floor(Number(count) || MIC_PRESENCE_SLICE_COUNT));
  const previous = Array.isArray(history) ? history.slice(-(safeCount - 1)) : [];
  const next = [...previous, createPresenceSlice(rmsDbfs, spectrumBands)];
  while (next.length < safeCount) next.unshift(emptyPresenceSlice());
  return next;
}
