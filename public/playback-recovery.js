export function playbackLeaderHealth(timeline) {
  if (!timeline || typeof timeline !== 'object') return 'unknown';

  const participantId = typeof timeline.playbackLeaderParticipantId === 'string'
    ? timeline.playbackLeaderParticipantId.trim()
    : '';
  const transportId = typeof timeline.playbackTransportId === 'string'
    ? timeline.playbackTransportId.trim()
    : '';
  const generation = Number(timeline.playbackGeneration);
  const hasLeader = Boolean(
    participantId
    && transportId
    && Number.isInteger(generation)
    && generation >= 0,
  );

  if (!hasLeader) return 'missing';
  if (timeline.leaderConnected === false) return 'disconnected';
  if (timeline.leaderFresh === false) return 'stale';
  if (timeline.leaderConnected === true && timeline.leaderFresh === true) return 'healthy';
  return 'unknown';
}

export function canRecoverPlayback({ role, timeline }) {
  if (role !== 'observer') return false;
  if (!timeline || typeof timeline !== 'object') return false;
  if (timeline.handoffState && timeline.handoffState !== 'idle') return false;

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
