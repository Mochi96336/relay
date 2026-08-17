import './playback-prewarm-trigger.js';

function safeGeneration(value) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

function roomSemanticToken(room) {
  const revision = safeGeneration(room?.revision);
  const videoId = typeof room?.videoId === 'string' ? room.videoId : '';
  const state = Number(room?.state);
  const playbackRate = Number(room?.playbackRate);
  return [
    revision === null ? 'revision-unknown' : `r${revision}`,
    videoId,
    Number.isInteger(state) ? `s${state}` : 'state-unknown',
    Number.isFinite(playbackRate) ? `p${playbackRate}` : 'rate-unknown',
  ].join(':');
}

/**
 * Convert authoritative room state into the subset the iframe can be asked to
 * restore deterministically. YouTube has no API operation for "be ended";
 * ended/unstarted therefore restore as a paused terminal position. The server
 * command gate treats only that narrow same-transport reload proof as
 * semantically equivalent instead of mistaking it for a user Pause command.
 */
export function reloadDesiredFromRoom(room) {
  if (!room || typeof room !== 'object') return null;
  const videoId = typeof room.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(room.videoId)
    ? room.videoId
    : null;
  if (!videoId) return null;

  const targetTime = Number(room.serverTime);
  const state = Number(room.state);
  const playbackRate = Number(room.playbackRate);
  return {
    videoId,
    positionSeconds: Number.isFinite(targetTime) ? Math.max(0, targetTime) : 0,
    state: state === 1 || state === 3 ? 1 : state === 5 ? 5 : 2,
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
  };
}

/**
 * Decide whether this page is replacing an older incarnation of its own
 * playback transport. The key includes the room semantic revision so a room
 * command that lands while the fresh iframe is still bootstrapping re-applies
 * the newest authoritative state instead of being hidden by same-role dedupe.
 */
export function playbackContinuationDecision({
  role,
  room,
  timeline,
  transportId,
  playbackGeneration,
}) {
  const currentGeneration = safeGeneration(playbackGeneration);
  const leaderGeneration = safeGeneration(timeline?.playbackGeneration);
  const sameTransport = Boolean(
    timeline
    && typeof transportId === 'string'
    && transportId
    && timeline.playbackTransportId === transportId,
  );

  if (
    role === 'holder'
    && typeof room?.videoId === 'string'
    && sameTransport
    && currentGeneration !== null
    && leaderGeneration !== null
    && currentGeneration > leaderGeneration
  ) {
    return {
      phase: 'continuing',
      key: `${transportId}:${currentGeneration}:${leaderGeneration}:${roomSemanticToken(room)}`,
    };
  }

  if (
    role === 'holder'
    && sameTransport
    && currentGeneration !== null
    && leaderGeneration !== null
    && currentGeneration === leaderGeneration
  ) {
    return { phase: 'complete', key: null };
  }

  return { phase: 'none', key: null };
}
