import './playback-transport-identity.js';
// youtube-sync imports this module before it constructs its private WebSocket.
// Keep reconnect terminal recovery in that playback dependency graph so the
// adapter can observe the exact socket without coupling it to prewarm/UI code.
import './playback-handoff-reconnect-recovery.js';
import { leaderHolding } from './playback-policy.js';

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

  // Observer is a surface with no controls at all: no song form, no player, and
  // every command refused before it is sent. That is the right answer while
  // somebody is actually driving the room, and a trap once they stop.
  //
  // `leaderHolding` deliberately uses the product-facing hold grace rather than
  // the shorter alignment freshness boundary. Recovery and feedback policy use
  // the same canonical snapshot helpers without collapsing those two meanings.
  if (leaderHolding(timeline)) return 'observer';
  return 'empty';
}
