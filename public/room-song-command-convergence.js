export const ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS = 0.75;
/** Landing slack for an explicit position mutation. Command delivery age is not part of this proof. */
export const ROOM_SONG_POSITION_TOLERANCE_SECONDS = ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS;
/** Causal iframe correction envelope for state-only commands; never position authority. */
export const ROOM_SONG_CAUSAL_CORRECTION_TOLERANCE_SECONDS = 1.5;
/** Reload-only equivalence slack for restoring a terminal position on a fresh iframe. */
export const ROOM_SONG_TERMINAL_RELOAD_TOLERANCE_SECONDS = 1.5;

/**
 * Classify how far an observed player has progressed toward a room command.
 *
 * Position-bearing commands use action semantics: Seek(80) means the browser
 * applies 80 when it receives the command. Network/queue age before browser
 * apply is therefore not projected into the positional proof. Ordinary
 * play/pause/rate commands carry room position only as descriptive context and
 * do not require positional convergence at all.
 *
 * `projectedPositionSeconds` remains accepted for wire/source compatibility,
 * but is deliberately not position authority.
 *
 * BUFFERING is progress toward PLAYING, never proof that Play completed.
 * Likewise UNSTARTED is only an intermediate while a cued player is coming up.
 */
export function roomSongCommandConvergence({
  desired,
  observed,
  projectedPositionSeconds: _projectedPositionSeconds = desired?.positionSeconds,
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
    const targetTime = Number(desired.positionSeconds);
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
 * Backward correction has its own causal envelope because YouTube can first
 * report the advancing edge and then correct its clock on the next sample.
 * This is evidence classification only: it never changes an explicit position
 * target and never causes seekTo().
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
    && delta >= -ROOM_SONG_CAUSAL_CORRECTION_TOLERANCE_SECONDS
  );
}
