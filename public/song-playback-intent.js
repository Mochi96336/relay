/**
 * Whether a YouTube player sample represents a *new* request to play.
 *
 * The player does not distinguish these two paths on its own:
 *
 *   PLAYING -> BUFFERING -> PLAYING   the network stalled; nobody asked
 *   ENDED   -> BUFFERING -> PLAYING   the singer restarted a finished song
 *
 * Both re-enter PLAYING from BUFFERING, so comparing against the previous
 * sample alone cannot tell them apart. Treating the second as a hiccup left the
 * room's authoritative position sitting at the ending: the replay was reported
 * as a bare seek, folded into a still-paused room, and the next apply pulled the
 * player straight back to the end. Carrying the last *settled* state across the
 * buffering samples is what separates them.
 */

/** YouTube's BUFFERING. A transport hiccup, never a playback intent. */
export const BUFFERING = 3;
/** YouTube's PLAYING. */
export const PLAYING = 1;

/**
 * The last state before this sample that was not buffering.
 *
 * Only the *previous* sample decides this. A buffering sample never becomes a
 * settled state itself; it passes the one it inherited along, so an arbitrarily
 * long stall still resolves to whatever the player was really doing.
 */
export function settledPlaybackState(previous) {
  if (!previous) return null;
  if (Number(previous.state) === BUFFERING) return previous.previousSettledState ?? null;
  return previous.state ?? null;
}

/**
 * A sample is a new play when the player is playing and was not already playing
 * before whatever buffering it passed through.
 */
export function isNewPlayIntent({ state, previousState, previousSettledState }) {
  if (Number(state) !== PLAYING) return false;
  if (previousState === PLAYING) return false;

  // Buffering is exactly the state that hides what the player was doing, so
  // falling back to it as the settled state answers the question with the one
  // value that cannot answer it - and "not playing" is what that fallback then
  // concludes. An unbroken history is available whenever there is one to have;
  // when there is not, an ordinary rebuffer was being read as somebody pressing
  // play, which put a command on the room and moved the player for it.
  const settled = previousSettledState ?? previousState;
  if (settled === null || settled === undefined || Number(settled) === BUFFERING) return false;

  return Number(settled) !== PLAYING;
}
