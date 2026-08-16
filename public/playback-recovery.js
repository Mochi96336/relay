export function playbackLeaderHealth(timeline) {
  if (!timeline || typeof timeline !== 'object') return 'missing';

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
  if (timeline.leaderConnected !== true) return 'disconnected';
  if (timeline.leaderFresh !== true) return 'stale';
  return 'healthy';
}

export function canRecoverPlayback({ role, timeline }) {
  if (role !== 'observer') return false;
  if (!timeline || typeof timeline !== 'object') return false;
  if (timeline.handoffState && timeline.handoffState !== 'idle') return false;
  return playbackLeaderHealth(timeline) !== 'healthy';
}

export function shouldForceMuteListen({ role, timeline }) {
  if (role !== 'holder' && role !== 'preparing') return false;
  if (!timeline || typeof timeline !== 'object') return false;
  if (playbackLeaderHealth(timeline) !== 'healthy') return false;

  const state = Number(timeline.state);
  return state === 1 || state === 3;
}
