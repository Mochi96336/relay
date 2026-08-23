export const ROOM_SONG_POSITION_TOLERANCE_SECONDS = 1.5;
export const ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS = 0.75;

/**
 * Classify how far an observed player has progressed toward a room command.
 *
 * This deliberately separates the room's descriptive position from a command's
 * mutation dimensions. Ordinary play/pause/rate commands carry a projected
 * room position for context, but they do not require the player to seek to it.
 * Load, explicit seek and replay do.
 *
 * BUFFERING is progress toward PLAYING, never proof that Play completed.
 * Likewise UNSTARTED is only an intermediate while a cued player is coming up.
 */
export function roomSongCommandConvergence({
  desired,
  observed,
  projectedPositionSeconds = desired?.positionSeconds,
  requirePosition = desired?.mustApplyPosition !== false,
  positionToleranceSeconds = ROOM_SONG_POSITION_TOLERANCE_SECONDS,
}) {
  if (!desired || !observed) return 'none';

  if (observed.videoId !== desired.videoId) return 'none';

  const observedRate = Number(observed.playbackRate);
  const desiredRate = Number(desired.playbackRate);
  if (
    !Number.isFinite(observedRate)
    || !Number.isFinite(desiredRate)
    || Math.abs(observedRate - desiredRate) > 0.0001
  ) return 'none';

  if (requirePosition) {
    const currentTime = Number(observed.currentTime);
    const targetTime = Number(projectedPositionSeconds);
    if (
      !Number.isFinite(currentTime)
      || !Number.isFinite(targetTime)
      || Math.abs(currentTime - targetTime) > positionToleranceSeconds
    ) return 'none';
  }

  const state = Number(observed.state);
  const desiredState = Number(desired.state);
  if (desiredState === 1) {
    if (state === 1) return 'complete';
    if (state === 3) return 'intermediate';
    return 'none';
  }
  if (desiredState === 2) return state === 2 ? 'complete' : 'none';
  if (desiredState === 5) {
    if (state === 5 || state === 2) return 'complete';
    if (state === -1) return 'intermediate';
  }
  return 'none';
}

/**
 * A state/rate command may legitimately move the media clock while it is being
 * applied even though it did not authorize a seek. Judge that movement against
 * the player's own immediately preceding sample, not the room projection.
 *
 * Forward motion is bounded by elapsed command time plus the local jump guard.
 * Backward correction uses the same positional proof envelope as server-side
 * command convergence: YouTube can first report the advancing edge and then
 * correct its clock on the next sample without that correction becoming a new
 * user Seek. This tolerance is evidence classification only; it never causes a
 * media reposition.
 */
export function roomSongCommandExplainsLocalDelta({
  desired,
  timelineDeltaSeconds,
  elapsedSinceApplySeconds,
}) {
  if (!desired || desired.mustApplyPosition !== false) return true;

  const delta = Number(timelineDeltaSeconds);
  if (!Number.isFinite(delta)) return false;

  const elapsed = Math.max(0, Number(elapsedSinceApplySeconds) || 0);
  const rate = Number.isFinite(Number(desired.playbackRate)) && Number(desired.playbackRate) > 0
    ? Number(desired.playbackRate)
    : 1;

  const forwardAllowance = desired.state === 1
    ? elapsed * rate + ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS
    : ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS;

  return (
    delta <= forwardAllowance
    && delta >= -ROOM_SONG_POSITION_TOLERANCE_SECONDS
  );
}
