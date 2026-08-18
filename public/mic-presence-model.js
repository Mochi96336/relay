export const MIC_PRESENCE_BAR_COUNT = 5;
export const MIC_PRESENCE_MIN_DBFS = -58;
export const MIC_PRESENCE_MAX_DBFS = -18;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Product-facing voice energy, not an engineering meter.
 *
 * Local RMS below -58 dBFS is treated as visual rest. Around -18 dBFS the
 * presence shape is already full-sized; louder peaks should not turn Live into
 * a clipping meter. The gentle exponent keeps ordinary speech visible without
 * making room noise look active.
 */
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

/**
 * Keep a short, truthful history of this phone's local microphone energy.
 * These bars are recent time slices, not fabricated frequency bands.
 */
export function nextPresenceHistory(history, rmsDbfs, count = MIC_PRESENCE_BAR_COUNT) {
  const safeCount = Math.max(1, Math.floor(Number(count) || MIC_PRESENCE_BAR_COUNT));
  const previous = Array.isArray(history)
    ? history.filter((value) => Number.isFinite(value)).slice(-(safeCount - 1))
    : [];
  const next = [...previous, rmsDbfsToPresence(rmsDbfs)];
  while (next.length < safeCount) next.unshift(0);
  return next;
}

export function presenceHeightPx(level) {
  const normalized = clamp(Number(level) || 0, 0, 1);
  return Math.round(5 + normalized * 29);
}
