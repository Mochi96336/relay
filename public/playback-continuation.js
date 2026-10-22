import { roomPlaybackTarget } from './song-playback-target.js';

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
 * restore deterministically. Dormant songs restore as cued controllers. Their
 * thumbnail/setup clock never replaces the logical room position or ended state.
 * A subsequent authorized Play applies that position (or replays from zero).
 */
export function reloadDesiredFromRoom(room) {
  return roomPlaybackTarget(room);
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
