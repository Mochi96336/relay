const WEB_SOCKET_OPEN = 1;

/**
 * Media-plane boundary used by microphone capture.
 *
 * Capture code only calls `send()`. The current implementation happens to
 * bind to the same WebSocket used by the control plane, but that physical
 * choice is contained here so a later media transport can replace it without
 * changing capture timing, packet framing, or the mixer.
 */
export class AudioTransport {
  constructor(kind) {
    this.kind = kind;
  }

  send(_packet) {
    throw new Error('AudioTransport.send() must be implemented by an adapter.');
  }
}

export class WebSocketAudioTransport extends AudioTransport {
  constructor({ maxBufferedBytes = 256 * 1024 } = {}) {
    super('websocket');
    if (!Number.isFinite(maxBufferedBytes) || maxBufferedBytes < 0) {
      throw new RangeError('maxBufferedBytes must be non-negative');
    }
    this.maxBufferedBytes = maxBufferedBytes;
    this.socket = null;
  }

  bind(socket) {
    this.socket = socket;
  }

  unbind(socket = this.socket) {
    if (this.socket === socket) this.socket = null;
  }

  state() {
    const socket = this.socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) {
      return { ready: false, reason: 'disconnected', bufferedAmount: 0 };
    }

    const bufferedAmount = Number(socket.bufferedAmount) || 0;
    if (bufferedAmount >= this.maxBufferedBytes) {
      return { ready: false, reason: 'congested', bufferedAmount };
    }

    return { ready: true, reason: null, bufferedAmount };
  }

  send(packet) {
    const state = this.state();
    if (!state.ready) return { ...state, sent: false };

    try {
      this.socket.send(packet);
      return { ...state, sent: true };
    } catch {
      return {
        ready: false,
        sent: false,
        reason: 'disconnected',
        bufferedAmount: state.bufferedAmount,
      };
    }
  }
}
