import type { TakeSongSnapshot } from './take-session.js';

/** Converts one already-time-addressed room Song status into durable Take metadata. */
export function takeSongSnapshotFromRoom(room: Record<string, unknown>): TakeSongSnapshot {
  const videoId = typeof room.videoId === 'string' && room.videoId ? room.videoId : null;
  if (videoId === null) {
    return {
      videoId: null,
      revision: null,
      state: null,
      serverTime: null,
      playbackRate: null,
    };
  }

  const revision = Number(room.revision);
  const state = Number(room.state);
  const serverTime = Number(room.serverTime);
  const playbackRate = Number(room.playbackRate);
  return {
    videoId,
    revision: Number.isInteger(revision) ? revision : null,
    state: Number.isFinite(state) ? state : null,
    serverTime: Number.isFinite(serverTime) ? serverTime : null,
    playbackRate: Number.isFinite(playbackRate) ? playbackRate : null,
  };
}
