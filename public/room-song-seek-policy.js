/**
 * What applying a room Song command may re-assert on the player.
 *
 * Position deliberately is not decided here. Whether to move the player is the
 * command's own provenance - a load, a seek, a replay - and not a distance to
 * measure: the position a command carries is the room's projection, which a
 * player falls behind by buffering alone, so any threshold turns an ordinary
 * play into a seek once the gap grows past it.
 */

/**
 * Whether applying a command has to re-assert the playback rate.
 *
 * Setting a rate the player already has is not free on an IFrame either, and a
 * command carries a rate whether or not it is the reason the command exists.
 */
export function shouldSetPlaybackRate({ currentRate, desiredRate } = {}) {
  const desired = Number(desiredRate);
  if (!Number.isFinite(desired) || desired <= 0) return false;

  // An unreadable current rate is not evidence that it already matches.
  if (currentRate === null || currentRate === undefined) return true;
  const current = Number(currentRate);
  if (!Number.isFinite(current) || current <= 0) return true;

  return Math.abs(current - desired) >= 0.001;
}
