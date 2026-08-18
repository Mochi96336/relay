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
 * old TCP connection, without making ordinary status broadcasts an audibility
 * authority.
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

function parseJsonMessage(data) {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function installBrowserRecovery() {
  if (
    typeof window === 'undefined'
    || typeof WebSocket === 'undefined'
    || typeof MessageEvent === 'undefined'
  ) return;

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket.__relayHandoffReconnectRecoveryInstalled) return;

  let playbackSocket = null;
  let playbackIdentity = null;

  const recovery = createPlaybackHandoffReconnectRecovery((payload) => {
    if (!playbackSocket || playbackSocket.readyState !== NativeWebSocket.OPEN) return;
    // Feed the reconstructed terminal through youtube-sync's normal message
    // handler so its private adapter state and youtube.js advance together.
    playbackSocket.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify(payload),
    }));
  });

  function trackPlaybackSocket(socket, hello) {
    playbackSocket = socket;
    playbackIdentity = {
      participantId: typeof window.relayParticipantId === 'string'
        ? window.relayParticipantId.trim()
        : '',
      transportId: typeof hello.playbackTransportId === 'string'
        ? hello.playbackTransportId
        : '',
      generation: Number(hello.playbackGeneration),
    };

    socket.addEventListener('message', (event) => {
      if (socket !== playbackSocket) return;
      const message = parseJsonMessage(event.data);
      if (!message) return;

      if (message.type === 'song-handoff-prepare') {
        recovery.notePrepare(message.handoffId);
        return;
      }
      if (message.type === 'song-handoff-commit') {
        recovery.noteCommit(message.handoffId);
        return;
      }
      if (message.type === 'song-handoff-complete') {
        recovery.noteComplete(message.handoffId);
        return;
      }
      if (message.type === 'song-handoff-cancelled') {
        recovery.noteCancelled();
        return;
      }
      if (message.type === 'youtube-timeline-status') {
        recovery.noteTimeline(message, playbackIdentity);
      }
    });

    socket.addEventListener('close', () => {
      if (socket !== playbackSocket) return;
      recovery.noteSocketClosed();
      playbackSocket = null;
    });
  }

  Object.defineProperty(NativeWebSocket, '__relayHandoffReconnectRecoveryInstalled', {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const socket = Reflect.construct(target, args, target);
      const nativeSend = socket.send.bind(socket);
      socket.send = (data) => {
        const message = parseJsonMessage(data);
        if (message?.type === 'playback-hello') {
          trackPlaybackSocket(socket, message);
          // Once identified, inbound events are enough. Stop inspecting every
          // subsequent telemetry/control send on this socket.
          socket.send = nativeSend;
        } else if (message && message.type !== 'participant-authenticate') {
          // Non-playback participant sockets normally authenticate first and
          // then identify their role. Retire the probe at that point.
          socket.send = nativeSend;
        }
        return nativeSend(data);
      };
      return socket;
    },
  });
}

installBrowserRecovery();
