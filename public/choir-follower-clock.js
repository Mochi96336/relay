// Browser-only local song following. This is NOT Mic/Content calibration.
export const FOLLOWER_ROOM_MAX_AGE_MS = 1_500;
export const FOLLOWER_SEEK_THRESHOLD_MS = 450;
export const FOLLOWER_SEEK_COOLDOWN_MS = 3_000;

export function projectFollowerRoom(room, receivedAtMs, nowMs) {
  if (!room || room.connected !== true || room.handoffState !== 'idle'
    || !/^[A-Za-z0-9_-]{11}$/.test(room.videoId)
    || !Number.isSafeInteger(room.revision) || room.revision < 0
    || ![1, 2].includes(room.state)
    || !Number.isFinite(room.serverTime) || room.serverTime < 0
    || !Number.isFinite(room.playbackRate) || room.playbackRate <= 0
    || room.playbackRate > 4
    || !Number.isFinite(receivedAtMs) || !Number.isFinite(nowMs)) return null;
  const ageMs = nowMs - receivedAtMs;
  if (ageMs < 0 || ageMs > FOLLOWER_ROOM_MAX_AGE_MS) return null;
  const projected = room.serverTime
    + (room.state === 1 ? ageMs * room.playbackRate / 1000 : 0);
  const duration = Number(room.duration);
  return {
    videoId: room.videoId,
    revision: room.revision,
    positionSeconds: Math.max(0, Number.isFinite(duration) && duration > 0
      ? Math.min(duration, projected) : projected),
    playbackRate: room.playbackRate,
    playing: room.state === 1,
    ageMs,
  };
}

// Actions affect only B's local player. They never send room commands.
export function decideFollowerAction(room, local, nowMs, lastSeekAtMs) {
  if (!room || !local?.ready) return { type: 'none', driftMs: null };
  if (local.videoId !== room.videoId) {
    return { type: 'cue', videoId: room.videoId, positionSeconds: room.positionSeconds, driftMs: null };
  }
  const driftMs = (local.positionSeconds - room.positionSeconds) * 1000;
  if (!Number.isFinite(driftMs)) return { type: 'none', driftMs: null };
  if (!room.playing && local.playerState === 1) return { type: 'pause', driftMs };
  if (local.playerState === 3) return { type: 'none', driftMs }; // buffering
  if (Math.abs(local.playbackRate - room.playbackRate) > 0.01) {
    return { type: 'rate', playbackRate: room.playbackRate, driftMs };
  }
  if (Math.abs(driftMs) >= FOLLOWER_SEEK_THRESHOLD_MS) {
    const sinceSeekMs = nowMs - lastSeekAtMs;
    if (sinceSeekMs >= FOLLOWER_SEEK_COOLDOWN_MS) {
      return { type: 'seek', positionSeconds: room.positionSeconds, driftMs };
    }
    // Seeking is rate-limited, but starting playback must NOT be rate-limited
    // by that same seek: a freshly cued B player would otherwise remain
    // paused for the entire cooldown and never catch the live room song.
    if (room.playing && local.playerState !== 1) return { type: 'play', driftMs };
    return { type: 'none', driftMs };
  }
  if (room.playing && local.playerState !== 1) return { type: 'play', driftMs };
  return { type: 'none', driftMs };
}
