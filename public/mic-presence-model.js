export const MIC_PRESENCE_SLICE_COUNT = 20;
export const MIC_PRESENCE_BAND_COUNT = 5;
export const MIC_PRESENCE_MIN_DBFS = -58;
export const MIC_PRESENCE_MAX_DBFS = -18;
export const MIC_PRESENCE_MIN_F0_HZ = 80;
export const MIC_PRESENCE_MAX_F0_HZ = 1000;

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
  const safe = Array.from({ length: MIC_PRESENCE_BAND_COUNT }, (_, index) => {
    const value = Number(spectrumBands[index]);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  });
  const strongest = Math.max(...safe);
  if (strongest <= 0) return safe;
  return safe.map((value) => clamp(value / strongest, 0, 1));
}

export function normalizeF0Hz(f0Hz) {
  if (f0Hz === null || f0Hz === undefined) return null;
  const value = Number(f0Hz);
  return Number.isFinite(value)
    && value >= MIC_PRESENCE_MIN_F0_HZ
    && value <= MIC_PRESENCE_MAX_F0_HZ
    ? value
    : null;
}

export function normalizePitchConfidence(pitchConfidence) {
  const value = Number(pitchConfidence);
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

export function pitchLobeCount(f0Hz) {
  const frequency = normalizeF0Hz(f0Hz);
  if (frequency === null) return 0;
  const baseDensity = 1.25 + 2.05 * Math.log2(frequency / 80);
  // Preserve the existing low register, then make real high-note evidence
  // progressively denser without changing amplitude or animation cadence.
  const highPitchBoost = 0.65 * Math.max(0, Math.log2(frequency / 150));
  return clamp(baseDensity + highPitchBoost, 1.25, 8.5);
}

export function pitchTextureStrength(f0Hz, pitchConfidence) {
  if (normalizeF0Hz(f0Hz) === null) return 0;
  const confidence = normalizePitchConfidence(pitchConfidence);
  return clamp((confidence - 0.35) / 0.5, 0, 1);
}

export function createPresenceSlice(rmsDbfs, spectrumBands, f0Hz = null, pitchConfidence = 0) {
  const presence = rmsDbfsToPresence(rmsDbfs);
  const shape = normalizeSpectrumBands(spectrumBands);
  return {
    presence,
    bands: shape.map((band) => presence <= 0 ? 0 : presence * (0.12 + 0.88 * band)),
    f0Hz: normalizeF0Hz(f0Hz),
    pitchConfidence: normalizePitchConfidence(pitchConfidence),
  };
}

export function emptyPresenceSlice() {
  return {
    presence: 0,
    bands: Array(MIC_PRESENCE_BAND_COUNT).fill(0),
    f0Hz: null,
    pitchConfidence: 0,
  };
}

export function presenceSliceGeometry(slice) {
  const presence = clamp(Number(slice?.presence) || 0, 0, 1);
  const f0Hz = normalizeF0Hz(slice?.f0Hz);
  return {
    amplitude: Math.pow(presence, 1.35),
    density: pitchLobeCount(f0Hz),
    pitchStrength: pitchTextureStrength(f0Hz, slice?.pitchConfidence),
    intensity: presence,
  };
}

export function centerOriginX(index, count = MIC_PRESENCE_SLICE_COUNT, width = 1) {
  const safeCount = Math.max(1, Math.floor(Number(count) || MIC_PRESENCE_SLICE_COUNT));
  const safeIndex = clamp(Math.floor(Number(index) || 0), 0, safeCount - 1);
  const safeWidth = Number.isFinite(Number(width)) && Number(width) > 0 ? Number(width) : 1;
  const newestIndex = safeCount - 1;
  const age = newestIndex - safeIndex;
  const distance = newestIndex > 0 ? (age / newestIndex) * (safeWidth / 2) : 0;
  return {
    left: safeWidth / 2 - distance,
    right: safeWidth / 2 + distance,
  };
}

export function nextPresenceHistory(
  history,
  rmsDbfs,
  spectrumBands,
  f0Hz = null,
  pitchConfidence = 0,
  count = MIC_PRESENCE_SLICE_COUNT,
) {
  const safeCount = Math.max(1, Math.floor(Number(count) || MIC_PRESENCE_SLICE_COUNT));
  const previous = Array.isArray(history) ? history.slice(-(safeCount - 1)) : [];
  const next = [...previous, createPresenceSlice(rmsDbfs, spectrumBands, f0Hz, pitchConfidence)];
  while (next.length < safeCount) next.unshift(emptyPresenceSlice());
  return next;
}
