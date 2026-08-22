/**
 * Whether applying a room Song command has to reposition the player.
 *
 * `seekTo` on a YouTube IFrame costs a visible re-buffer every time, including
 * when the target is where the player already is. Applying every command with
 * an unconditional seek therefore made each play press stutter by a fixed
 * amount - not drift accumulating, but the seek itself, paid once per command.
 *
 * The position a command carries is the room clock's *prediction* of where the
 * player should be, and a player that re-buffers falls behind that prediction
 * without anybody seeking. So a small disagreement is the normal state of a
 * healthy room, not evidence that the player needs moving.
 *
 * A load, an explicit seek, or a command that just cued a different video all
 * have to position the player: there is no meaningful "current position" to
 * compare against. Everything else - play, pause, a rate change - moves it only
 * when the gap is worth more than the stutter that closing it costs.
 */

/**
 * Chosen against what the gap sounds like rather than what it measures. Below
 * roughly a third of a second the player catches up on its own within a phrase,
 * while a seek is audible immediately and every time.
 */
export const ROOM_SONG_SEEK_TOLERANCE_SECONDS = 0.35;

export function shouldSeekForRoomCommand({
  action,
  videoChanged = false,
  currentSeconds,
  desiredSeconds,
  toleranceSeconds = ROOM_SONG_SEEK_TOLERANCE_SECONDS,
} = {}) {
  if (action === 'load' || action === 'seek') return true;
  if (videoChanged) return true;

  // `Number(null)` is 0, which would read a malformed command as a request to
  // seek to the start of the song.
  if (desiredSeconds === null || desiredSeconds === undefined) return false;
  const desired = Number(desiredSeconds);
  if (!Number.isFinite(desired) || desired < 0) return false;

  // No trustworthy reading of where the player is means no basis for deciding
  // the gap is small. Position it, as before.
  if (currentSeconds === null || currentSeconds === undefined) return true;
  const current = Number(currentSeconds);
  if (!Number.isFinite(current) || current < 0) return true;

  const tolerance = Number(toleranceSeconds);
  const limit = Number.isFinite(tolerance) && tolerance >= 0
    ? tolerance
    : ROOM_SONG_SEEK_TOLERANCE_SECONDS;
  return Math.abs(current - desired) > limit;
}
