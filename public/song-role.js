function samePlaybackTransport(status, participantId, transportId, keys) {
  if (!status || typeof status !== 'object' || !participantId || !transportId) return false;
  return status[keys.participant] === participantId
    && status[keys.transport] === transportId;
}

function exactPlayback(status, participantId, transportId, playbackGeneration, keys) {
  return samePlaybackTransport(status, participantId, transportId, keys)
    && Number(status[keys.generation]) === playbackGeneration;
}

function currentOrNewerLeader(status, participantId, transportId, playbackGeneration) {
  if (!samePlaybackTransport(status, participantId, transportId, {
    participant: 'playbackLeaderParticipantId',
    transport: 'playbackTransportId',
  })) return false;

  const leaderGeneration = Number(status.playbackGeneration);
  return Number.isInteger(leaderGeneration)
    && leaderGeneration >= 0
    && playbackGeneration >= leaderGeneration;
}

export function resolvePlaybackRole({
  timeline,
  room,
  participantId,
  transportId,
  playbackGeneration,
}) {
  if (!timeline || typeof timeline !== 'object') return null;

  const hasSong = typeof room?.videoId === 'string' || typeof timeline.videoId === 'string';
  if (!hasSong) return 'empty';

  if (
    timeline.handoffState !== 'idle'
    && exactPlayback(timeline, participantId, transportId, playbackGeneration, {
      participant: 'handoffTargetParticipantId',
      transport: 'handoffTargetPlaybackTransportId',
      generation: 'handoffTargetPlaybackGeneration',
    })
  ) return 'preparing';

  // SongSession treats a page reload as a newer incarnation of the same
  // playback transport. Let that continuation keep the holder surface so its
  // first telemetry packet can replace the older generation. A different tab
  // still has another transport id and remains an observer.
  if (currentOrNewerLeader(timeline, participantId, transportId, playbackGeneration)) {
    return 'holder';
  }

  return 'observer';
}
