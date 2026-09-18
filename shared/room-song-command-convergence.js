export const ROOM_SONG_POSITION_TOLERANCE_SECONDS = 1.5;
export const ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS = 0.75;
export const ROOM_SONG_RATE_TOLERANCE = 0.0001;

/**
 * Classify how far an observed player has progressed toward a room command.
 *
 * This deliberately separates the room's descriptive position from a command's
 * mutation dimensions. Ordinary play/pause/rate commands carry a projected
 * room position for context, but they do not require the player to seek to it.
 * Load, explicit seek and replay do.
 *
 * `positionMinSeconds` / `positionMaxSeconds` let the server prove an apply-time
 * position action without pretending it knows when the remote player actually
 * applied it. The browser, which does know its local apply time, normally uses
 * the single projected point instead.
 *
 * BUFFERING is progress toward PLAYING, never proof that Play completed.
 * Likewise UNSTARTED is only an intermediate while a cued player is coming up.
 */
export function roomSongCommandConvergence({
  desired,
  observed,
  projectedPositionSeconds = desired?.positionSeconds,
  positionMinSeconds = projectedPositionSeconds,
  positionMaxSeconds = projectedPositionSeconds,
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
    || Math.abs(observedRate - desiredRate) > ROOM_SONG_RATE_TOLERANCE
  ) return 'none';

  if (requirePosition) {
    const currentTime = Number(observed.currentTime);
    const firstBound = Number(positionMinSeconds);
    const secondBound = Number(positionMaxSeconds);
    if (
      !Number.isFinite(currentTime)
      || !Number.isFinite(firstBound)
      || !Number.isFinite(secondBound)
    ) return 'none';

    const lower = Math.min(firstBound, secondBound) - positionToleranceSeconds;
    const upper = Math.max(firstBound, secondBound) + positionToleranceSeconds;
    if (currentTime < lower || currentTime > upper) return 'none';
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
 * Decide whether a local media-clock discontinuity is still causally owned by
 * a state/rate-only room command, while carrying the minimum provenance needed
 * to admit a later YouTube clock correction.
 *
 * Command age is not position authority. Once the player is already in the
 * commanded state, ordinary continuity is bounded only by the local jump
 * tolerance. A larger discontinuity is owned only when it occurs on the actual
 * command-dimension transition. That observed transition creates a signed
 * correction debt; a later opposite-direction correction may consume it.
 *
 * This preserves the observed +813 ms transition followed by a -833 ms raw
 * YouTube correction without giving an otherwise-stable pending Play an
 * ever-growing seek envelope.
 */
export function roomSongCommandLocalDeltaEvidence({
  desired,
  timelineDeltaSeconds,
  elapsedSinceApplySeconds,
  commandTransition = false,
  correctionDebtSeconds = 0,
}) {
  if (!desired || desired.mustApplyPosition !== false) {
    return { explained: true, correctionDebtSeconds: 0 };
  }

  const delta = Number(timelineDeltaSeconds);
  const debt = Number(correctionDebtSeconds);
  const normalizedDebt = Number.isFinite(debt) ? debt : 0;
  if (!Number.isFinite(delta)) {
    return { explained: false, correctionDebtSeconds: normalizedDebt };
  }

  if (Math.abs(delta) <= ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS) {
    return { explained: true, correctionDebtSeconds: normalizedDebt };
  }

  const elapsed = Math.max(0, Number(elapsedSinceApplySeconds) || 0);
  const rate = Number.isFinite(Number(desired.playbackRate)) && Number(desired.playbackRate) > 0
    ? Number(desired.playbackRate)
    : 1;

  if (commandTransition) {
    const forwardAllowance = desired.state === 1
      ? elapsed * rate + ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS
      : ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS;
    const transitionExplained = (
      delta <= forwardAllowance
      && delta >= -ROOM_SONG_POSITION_TOLERANCE_SECONDS
    );
    if (transitionExplained) {
      return { explained: true, correctionDebtSeconds: delta };
    }
  }

  const oppositeCorrection = (
    normalizedDebt !== 0
    && Math.sign(delta) === -Math.sign(normalizedDebt)
    && Math.abs(delta) <= Math.abs(normalizedDebt) + ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS
  );
  if (oppositeCorrection) {
    const remainingDebt = normalizedDebt + delta;
    return {
      explained: true,
      correctionDebtSeconds: Math.abs(remainingDebt) <= ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS
        ? 0
        : remainingDebt,
    };
  }

  return { explained: false, correctionDebtSeconds: normalizedDebt };
}
