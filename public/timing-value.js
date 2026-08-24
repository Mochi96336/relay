/**
 * Formats an already-authoritative mixer timing value for normal product UI.
 *
 * This module deliberately does not decide which timing source is authoritative;
 * the server boundary owns that. It also applies no deadband or presentation
 * threshold: a real +37 ms remains +37 ms instead of becoming 0.
 */
export function formatTimingValueMs(valueMs) {
  if (typeof valueMs !== 'number' || !Number.isFinite(valueMs)) return null;
  const rounded = Math.round(valueMs);
  return `${rounded > 0 ? '+' : ''}${rounded} ms`;
}
