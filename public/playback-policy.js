// Product-facing playback policy derived from the server SongSession snapshot.
//
// Keep two time scales explicit:
// - leaderFresh is the server's short alignment/authority freshness signal.
// - LEADER_HOLD_GRACE_MS is a slower UI continuity grace so ordinary browser
//   timer throttling or rebuffering does not make control surfaces flicker.
// These are intentionally different facts, not competing definitions of one
// boolean.
export const LEADER_HOLD_GRACE_MS = 6_000;

function playbackLeaderIdentity(timeline) {
  if (!timeline || typeof timeline !== 'object') return null;

  const participantId = typeof timeline.playbackLeaderParticipantId === 'string'
    ? timeline.playbackLeaderParticipantId.trim()
    : '';
  const transportId = typeof timeline.playbackTransportId === 'string'
    ? timeline.playbackTransportId.trim()
    : '';
  const generation = Number(timeline.playbackGeneration);

  if (!participantId || !transportId || !Number.isInteger(generation) || generation < 0) {
    return null;
  }
  return { participantId, transportId, generation };
}

export function playbackLeaderHealth(timeline) {
  if (!timeline || typeof timeline !== 'object') return 'unknown';
  if (!playbackLeaderIdentity(timeline)) return 'missing';
  if (timeline.leaderConnected === false) return 'disconnected';
  if (timeline.leaderFresh === false) return 'stale';
  if (timeline.leaderConnected === true && timeline.leaderFresh === true) return 'healthy';
  return 'unknown';
}

export function leaderHolding(timeline) {
  if (!playbackLeaderIdentity(timeline)) return false;
  if (timeline.leaderConnected === false) return false;
  if (timeline.leaderFresh === true) return true;

  const ageMs = Number(timeline.ageMs);
  if (!Number.isFinite(ageMs)) return timeline.connected !== false;
  return ageMs <= LEADER_HOLD_GRACE_MS;
}

export function canRecoverPlayback({ role, timeline }) {
  if (role !== 'observer') return false;
  if (!timeline || typeof timeline !== 'object') return false;
  if (timeline.handoffState && timeline.handoffState !== 'idle') return false;

  const health = playbackLeaderHealth(timeline);
  return health === 'missing' || health === 'disconnected' || health === 'stale';
}

/**
 * When the Mic is free, changing the room Song is a shared action. The server
 * still routes that load through the one healthy playback leader, so shared
 * control never implies that every participant becomes an audio source.
 *
 * While somebody owns the Mic, that singer remains the product-level Song
 * controller even when the exact iframe that supplied the media clock has
 * disappeared. The next command still goes through server authority.
 */
export function canChangeRoomSong({ role, timeline, isMicOwner, isMicFree }) {
  if (!timeline || typeof timeline !== 'object') return false;
  if (timeline.handoffState && timeline.handoffState !== 'idle') return false;

  const hasSong = typeof timeline.videoId === 'string' && timeline.videoId.length > 0;
  // Exact playback authority is sufficient UI evidence on its own. Mic state
  // arrives on a separate canonical snapshot and must not make the real holder
  // lose its control while those snapshots reconnect or cross in flight.
  if (hasSong && role === 'holder') return true;
  if (isMicFree) return true;
  if (!isMicOwner) return false;
  if (!hasSong) return true;

  const health = playbackLeaderHealth(timeline);
  return health === 'missing' || health === 'disconnected' || health === 'stale';
}

export function shouldForceMuteListen({ role, timeline }) {
  if (role !== 'holder' && role !== 'preparing') return false;
  if (!timeline || typeof timeline !== 'object') return false;

  const health = playbackLeaderHealth(timeline);
  // Missing health fields are not evidence that playback stopped. Fail closed
  // so an older/partial status cannot accidentally open an acoustic feedback
  // path while this phone still renders as the local playback source.
  if (health !== 'healthy' && health !== 'unknown') return false;

  const state = Number(timeline.state);
  return state === 1 || state === 3;
}
