function exactPlayback(status, participantId, transportId, playbackGeneration, keys) {
  if (!status || typeof status !== 'object' || !participantId || !transportId) return false;
  return status[keys.participant] === participantId
    && status[keys.transport] === transportId
    && Number(status[keys.generation]) === playbackGeneration;
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

  if (exactPlayback(timeline, participantId, transportId, playbackGeneration, {
    participant: 'playbackLeaderParticipantId',
    transport: 'playbackTransportId',
    generation: 'playbackGeneration',
  })) return 'holder';

  return 'observer';
}
