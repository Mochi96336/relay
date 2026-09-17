export const DEFAULT_PUBLISHER_CONTROL_LIVENESS_MS = 4_000;

function parseRelayMessage(data) {
  if (typeof data !== 'string') return null;
  try {
    const value = JSON.parse(data);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function validCaptureGeneration(value) {
  return Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
}

export class PublisherControlLiveness {
  constructor({
    timeoutMs = DEFAULT_PUBLISHER_CONTROL_LIVENESS_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Publisher control liveness timeout must be positive.');
    }
    this.timeoutMs = timeoutMs;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.observedSockets = new WeakSet();
    this.activeSocket = null;
    this.deadline = null;
    this.leaseEpoch = 0;
    this.lastAckGeneration = null;
  }

  observe(socket) {
    if (!socket || typeof socket.addEventListener !== 'function') return false;
    if (this.observedSockets.has(socket)) return true;
    this.observedSockets.add(socket);
    socket.addEventListener('message', (event) => this.handleMessage(socket, event?.data));
    socket.addEventListener('close', () => this.handleClose(socket));
    return true;
  }

  handleMessage(socket, data) {
    const message = parseRelayMessage(data);
    if (!message) return false;

    if (message.type === 'registered' && message.role === 'publisher') {
      this.activate(socket);
      return true;
    }

    if (message.type !== 'audio-uplink-health-ack' || socket !== this.activeSocket) return false;
    if (message.version !== 1 || !validCaptureGeneration(message.captureGeneration)) return false;

    this.lastAckGeneration = message.captureGeneration >>> 0;
    this.renew(socket);
    return true;
  }

  handleClose(socket) {
    if (socket !== this.activeSocket) return false;
    this.clearDeadline();
    this.activeSocket = null;
    this.lastAckGeneration = null;
    this.leaseEpoch += 1;
    return true;
  }

  snapshot() {
    return {
      active: this.activeSocket !== null,
      lastAckGeneration: this.lastAckGeneration,
      leaseEpoch: this.leaseEpoch,
    };
  }

  activate(socket) {
    this.clearDeadline();
    this.activeSocket = socket;
    this.lastAckGeneration = null;
    this.leaseEpoch += 1;
    this.arm(socket, this.leaseEpoch);
  }

  renew(socket) {
    this.clearDeadline();
    this.leaseEpoch += 1;
    this.arm(socket, this.leaseEpoch);
  }

  arm(socket, expectedEpoch) {
    const timer = this.setTimer(() => {
      if (this.deadline !== timer) return;
      this.deadline = null;
      if (this.activeSocket !== socket || this.leaseEpoch !== expectedEpoch) return;
      try {
        socket.close(4000, 'publisher command liveness stale');
      } catch {}
    }, this.timeoutMs);
    timer?.unref?.();
    this.deadline = timer;
  }

  clearDeadline() {
    if (this.deadline !== null) this.clearTimer(this.deadline);
    this.deadline = null;
  }
}

const publisherControlLiveness = new PublisherControlLiveness();

export function observePublisherControlLiveness(socket) {
  return publisherControlLiveness.observe(socket);
}
