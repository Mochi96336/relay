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

/** YouTube PLAYING (1) or BUFFERING (3): the room song is moving. */
function roomSongMoving(state: unknown): boolean {
  const n = Number(state);
  return n === 1 || n === 3;
}

/**
 * Whether the room's YouTube song is the backing a Take would record.
 *
 * A premixed Mic (local file mode) carries its own song. A YouTube video the
 * room merely has loaded - cued, paused, ended - is then not part of the
 * recording: it neither needs an external backing to be healthy nor names the
 * Take. Only a room song actually moving while the local file is in the Mic
 * still is (the local file is held while it plays).
 */
export function roomSongIsTakeBacking(
  room: { videoId: unknown; state: unknown },
  micPremixed: boolean,
): boolean {
  if (typeof room.videoId !== 'string' || !room.videoId) return false;
  return !micPremixed || roomSongMoving(room.state);
}

/** The Take's song: the room's YouTube song, or the premixed local file instead of a song it does not hear. */
export function takeSongSnapshotForMic(
  room: Record<string, unknown>,
  localFile: { title: string | null; heard: boolean } | null,
): TakeSongSnapshot {
  if (!localFile) return takeSongSnapshotFromRoom(room);
  const song = roomSongIsTakeBacking({ videoId: room.videoId, state: room.state }, true)
    ? takeSongSnapshotFromRoom(room)
    : takeSongSnapshotFromRoom({});
  return { ...song, localFile: { ...localFile } };
}
