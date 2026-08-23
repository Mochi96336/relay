import {
  ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS,
  ROOM_SONG_POSITION_TOLERANCE_SECONDS,
} from './room-song-command-convergence.js';

/**
 * Report every semantic dimension an observation changes relative to the room.
 *
 * The old gate returned one action by priority (video, rate, state, position).
 * That allowed a state change to hide a simultaneous seek in the same packet.
 * Authority is dimensional: a pending Play owns the state transition, not an
 * arbitrary scrub that happened at the same time.
 */
export function roomSongObservedMutations({ observed, room }) {
  const mutations = new Set();
  if (!observed || !room) return mutations;

  const incomingVideoId = typeof observed.videoId === 'string' ? observed.videoId : null;
  const roomVideoId = typeof room.videoId === 'string' ? room.videoId : null;
  if (!roomVideoId) {
    if (incomingVideoId) mutations.add('load');
    return mutations;
  }
  if (incomingVideoId && incomingVideoId !== roomVideoId) {
    mutations.add('load');
    return mutations;
  }

  const roomRate = Number(room.playbackRate);
  const incomingRate = Number(observed.playbackRate ?? 1);
  if (
    Number.isFinite(roomRate)
    && Number.isFinite(incomingRate)
    && Math.abs(roomRate - incomingRate) > 0.0001
  ) mutations.add('rate');

  const roomState = Number(room.state);
  const incomingState = Number(observed.state);
  if (incomingState === 1 && ![1, 3].includes(roomState)) mutations.add('play');
  if (incomingState === 2 && roomState !== 2) mutations.add('pause');
  if (incomingState === 5 && roomState !== 5) mutations.add('load');

  // Compare position to the player's own last accepted report, not to the room
  // projection. A rebuffer can lag the room without anyone seeking.
  const reportedTime = Number(room.youtubeTime);
  const incomingTime = Number(observed.currentTime);
  const elapsedSeconds = Math.max(0, Number(room.ageMs) || 0) / 1000;
  if (Number.isFinite(reportedTime) && Number.isFinite(incomingTime)) {
    const delta = incomingTime - reportedTime;
    if (
      delta > ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS
      || delta < -(elapsedSeconds + ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS)
    ) mutations.add('seek');
  }

  return mutations;
}

/**
 * A pending command owns only the dimensions it actually requested. The sole
 * exception is causal position movement produced by a state/rate command: the
 * media clock can advance while the room still reflects the pre-command sample.
 * Bound that movement to the command's own accepted/projection envelope rather
 * than calling it a new Seek.
 */
export function roomSongPendingOwnsMutation({
  mutation,
  commandAction,
  desired,
  currentTime,
  projectedPositionSeconds,
}) {
  if (mutation === commandAction) return true;
  if (mutation !== 'seek') return false;
  if (desired?.mustApplyPosition === true) return true;

  const current = Number(currentTime);
  const accepted = Number(desired?.positionSeconds);
  const projected = Number(projectedPositionSeconds);
  if (!Number.isFinite(current) || !Number.isFinite(accepted) || !Number.isFinite(projected)) {
    return false;
  }

  const lower = Math.min(accepted, projected) - ROOM_SONG_POSITION_TOLERANCE_SECONDS;
  const upper = Math.max(accepted, projected) + ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS;
  return current >= lower && current <= upper;
}
