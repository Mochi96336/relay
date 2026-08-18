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
 * Compress five real frequency bands into one continuous visual slice.
 * `center` is a normalized vertical position (0=high/top, 1=low/bottom), while
 * `height` preserves spectral spread. This keeps high/low information visible
 * without drawing a 10×5 LED matrix. Loudness remains `intensity`, owned by RMS.
 */
export function presenceSliceGeometry(slice) {
  const presence = clamp(Number(slice?.presence) || 0, 0, 1);
  const bands = Array.from({ length: MIC_PRESENCE_BAND_COUNT }, (_, index) => (
    clamp(Number(slice?.bands?.[index]) || 0, 0, 1)
  ));
  if (presence <= 0 || Math.max(...bands) <= 0) {
    return { center: 0.5, height: 0.16, intensity: 0 };
  }

  // createPresenceSlice leaves a small floor in every band so quiet harmonics
  // never vanish completely. Remove that common floor for centroid/spread so a
  // genuinely low or bright voice still moves the ribbon vertically.
  const floor = Math.min(...bands);
  let weights = bands.map((band) => Math.max(0, band - floor));
  let total = weights.reduce((sum, value) => sum + value, 0);
  if (total <= 1e-6) {
    weights = bands;
    total = weights.reduce((sum, value) => sum + value, 0);
  }

  const maxBandIndex = Math.max(1, MIC_PRESENCE_BAND_COUNT - 1);
  const centroid = weights.reduce((sum, value, index) => (
    sum + value * (index / maxBandIndex)
  ), 0) / total;
  const variance = weights.reduce((sum, value, index) => {
    const position = index / maxBandIndex;
    return sum + value * ((position - centroid) ** 2);
  }, 0) / total;
  const spread = Math.sqrt(Math.max(0, variance));

  // Band index rises with frequency, while screen Y rises downward.
  const center = clamp(0.76 - centroid * 0.52, 0.2, 0.8);
  const height = clamp(0.18 + spread * 1.05 + presence * 0.09, 0.18, 0.58);
  return { center, height, intensity: presence };
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
