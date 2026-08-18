function validHandoffId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function samePlaybackIdentity(status, identity) {
  return Boolean(
    status
    && identity
    && status.playbackLeaderParticipantId === identity.participantId
    && status.playbackTransportId === identity.transportId
    && Number(status.playbackGeneration) === identity.generation,
  );
}

/**
 * Remembers only server-confirmed handoff phase plus whether its playback
 * WebSocket actually disconnected. A fresh timeline from the replacement
 * socket may then reconstruct a terminal direct packet that was lost with the
 * old connection, without making ordinary status broadcasts an audibility
 * authority.
 *
 * Socket ownership deliberately stays outside this pure state machine. The
 * playback transport owner (`youtube-sync.js`) feeds lifecycle events in and
 * routes recovered terminals back through its normal message handler.
 */
export function createPlaybackHandoffReconnectRecovery(emitTerminal) {
  let handoffId = null;
  let phase = 'idle';
  let disconnected = false;

  function reset() {
    handoffId = null;
    phase = 'idle';
    disconnected = false;
  }

  return {
    notePrepare(nextHandoffId) {
      const nextId = validHandoffId(nextHandoffId);
      if (!nextId) return;
      if (phase === 'committing' && handoffId === nextId) {
        // playback-hello replays a live handoff as prepare. Seeing the same
        // plan after reconnect proves the server did not complete it while the
        // socket was away, so a later promotion must use the normal direct
        // release/complete cutover.
        disconnected = false;
        return;
      }
      handoffId = nextId;
      phase = 'preparing';
      disconnected = false;
    },

    noteCommit(nextHandoffId) {
      const nextId = validHandoffId(nextHandoffId);
      if (!nextId) return;
      handoffId = nextId;
      phase = 'committing';
      disconnected = false;
    },

    noteComplete(completedHandoffId) {
      if (!completedHandoffId || completedHandoffId === handoffId) reset();
    },

    noteCancelled() {
      reset();
    },

    noteSocketClosed() {
      if (handoffId && phase !== 'idle') disconnected = true;
    },

    noteTimeline(status, identity) {
      if (!disconnected || !handoffId || phase === 'idle' || !status) return false;

      const currentHandoffId = validHandoffId(status.handoffId);
      // This exact handoff is still server-owned. There is no missing terminal
      // packet to reconstruct.
      if (currentHandoffId === handoffId && status.handoffState !== 'idle') return false;

      const terminalHandoffId = handoffId;
      if (phase === 'committing' && samePlaybackIdentity(status, identity)) {
        reset();
        emitTerminal({
          type: 'song-handoff-complete',
          handoffId: terminalHandoffId,
          recoveredAfterReconnect: true,
        });
        return true;
      }

      // A fresh authoritative timeline says the remembered handoff no longer
      // exists and this transport did not become leader. Its cancellation was
      // the terminal packet lost with the old socket.
      reset();
      emitTerminal({
        type: 'song-handoff-cancelled',
        handoffId: terminalHandoffId,
        recoveredAfterReconnect: true,
      });
      return true;
    },
  };
}
