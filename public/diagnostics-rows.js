/**
 * The pieces every Technical details model builds its rows from. A row is a
 * plain value, a one-line note on what it means, and a tone.
 */

/** A number, or null for anything missing. Number(null) is 0, a real reading. */
export function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function row(key, label, value, note = '', tone = 'neutral') {
  return { key, label, value, note, tone };
}

/** A row Relay has no reading for yet. */
export function unknown(t, key, labelKey) {
  return row(key, t(labelKey), t('diag.unknown'));
}

/** Milliseconds with their sign, as the Realign value shows them. */
export function signedMs(ms) {
  const rounded = Math.round(ms) || 0;
  return `${rounded > 0 ? '+' : ''}${rounded} ms`;
}
