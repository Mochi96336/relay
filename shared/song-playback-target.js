/** Playing/buffering rooms need a running player. Dormant rooms need controls. */
/** @param {unknown} roomState */
export function playbackTargetState(roomState) {
  return [1, 3].includes(Number(roomState)) ? 1 : 5;
}

/** An ended controller prepares Replay; paused/cued songs keep their position. */
/** @param {Record<string, unknown> | null | undefined} room */
export function playbackStartPosition(room) {
  const position = Number(room?.serverTime);
  return Number(room?.state) === 0 ? 0 : Number.isFinite(position) ? Math.max(0, position) : 0;
}

/** The same physical target policy drives handoff and same-tab restoration. */
/** @param {Record<string, unknown> | null | undefined} room */
export function roomPlaybackTarget(room) {
  if (!room || typeof room !== 'object') return null;
  const videoId = typeof room.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(room.videoId)
    ? room.videoId : null;
  if (!videoId) return null;
  const rate = Number(room.playbackRate);
  return {
    videoId,
    positionSeconds: playbackStartPosition(room),
    state: playbackTargetState(room.state),
    playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1,
    ended: Number(room.state) === 0,
  };
}
