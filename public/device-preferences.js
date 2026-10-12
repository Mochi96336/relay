// Volume choices that belong to this device rather than to the room: what it
// plays the room at, and the Mic gain that suits its microphone. Kept in
// browser storage so a page reload or a Relay restart does not reset them.
// Storage can be unavailable (private browsing, blocked site data); the page
// then simply starts from its defaults.

export const LISTEN_VOLUME_KEY = 'relay.listenVolumePercent.v1';
export const MIC_GAIN_KEY = 'relay.micGainDb.v1';

/** The stored number, clamped to [min, max]; null when absent or unreadable. */
export function storedNumber(key, min, max) {
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (raw === null || raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  return Math.max(min, Math.min(max, value));
}

export function storeNumber(key, value) {
  if (!Number.isFinite(value)) return;
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Not remembered on this device; the control still works.
  }
}
