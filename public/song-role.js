function samePlaybackTransport(status, participantId, transportId, keys) {
  if (!status || typeof status !== 'object' || !participantId || !transportId) return false;
  return status[keys.participant] === participantId
    && status[keys.transport] === transportId;
}

function exactPlayback(status, participantId, transportId, playbackGeneration, keys) {
  return samePlaybackTransport(status, participantId, transportId, keys)
    && Number(status[keys.generation]) === playbackGeneration;
}

/**
 * Whether the room still has a leader worth deferring to.
 *
 * Mirrors the server's own `healthyLeader`: connected, and reporting recently
 * enough to still be driving the clock. Deliberately slower than the 1.5 s the
 * timeline uses to decide the clock is authoritative - a brief rebuffer must
 * not make the controls flicker in and out on every other device.
 */
const LEADER_HOLD_GRACE_MS = 6_000;

function leaderHolding(status) {
  if (status.playbackLeaderParticipantId === null
    || status.playbackLeaderParticipantId === undefined) return false;
  if (status.leaderConnected === false) return false;
  if (status.leaderFresh === true) return true;

  const ageMs = Number(status.ageMs);
  if (!Number.isFinite(ageMs)) return status.connected !== false;
  return ageMs <= LEADER_HOLD_GRACE_MS;
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
  // The server already draws this line - a command against a leader that is
  // disconnected or stale is accepted rather than sent for handoff - but this
  // side only ever compared identities, so a tab that was left open kept the
  // room to itself for as long as it existed, and every other device sat
  // looking at controls it could not reach. Hand the room back when its leader
  // stops holding it.
  if (leaderHolding(timeline)) return 'observer';
  return 'empty';
}
