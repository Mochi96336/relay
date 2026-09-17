export const DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS = 3_000;
export const DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS = 4_000;

function uint32(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 0xffff_ffff
    ? number >>> 0
    : null;
}

export class PublisherCommandLiveness {
  constructor({
    freshMs = DEFAULT_PUBLISHER_COMMAND_ACK_FRESH_MS,
    reconnectMs = DEFAULT_PUBLISHER_COMMAND_RECONNECT_MS,
  } = {}) {
    if (!Number.isFinite(freshMs) || freshMs <= 0) {
      throw new Error('Publisher command freshMs must be positive.');
    }
    if (!Number.isFinite(reconnectMs) || reconnectMs <= freshMs) {
      throw new Error('Publisher command reconnectMs must be greater than freshMs.');
    }
    this.freshMs = freshMs;
    this.reconnectMs = reconnectMs;
    this.reset();
  }

  reset() {
    this.generation = null;
    this.startedAtMs = -Infinity;
    this.lastAckAtMs = -Infinity;
    this.nextHealthRequestId = 0;
    this.pendingHealthRequests = new Map();
  }

  begin(generation, nowMs) {
    const normalizedGeneration = uint32(generation);
    if (normalizedGeneration === null) throw new Error('Publisher command generation must be a uint32.');
    if (!Number.isFinite(nowMs)) throw new Error('Publisher command begin time must be finite.');
    const generationChanged = this.generation !== normalizedGeneration;
    this.generation = normalizedGeneration;
    this.startedAtMs = nowMs;
    this.lastAckAtMs = -Infinity;
    if (generationChanged) this.nextHealthRequestId = 0;
    this.pendingHealthRequests.clear();
  }

  beginHealthRequest(nowMs) {
    if (this.generation === null || !Number.isFinite(nowMs)) return null;
    const requestId = this.nextHealthRequestId >>> 0;
    this.nextHealthRequestId = (requestId + 1) >>> 0;
    this.pendingHealthRequests.set(requestId, nowMs);
    return requestId;
  }

  cancelHealthRequest(requestId) {
    const normalizedRequestId = uint32(requestId);
    if (normalizedRequestId === null) return false;
    return this.pendingHealthRequests.delete(normalizedRequestId);
  }

  noteAck(generation, requestId, nowMs) {
    const normalizedGeneration = uint32(generation);
    const normalizedRequestId = uint32(requestId);
    if (
      this.generation === null
      || normalizedGeneration === null
      || normalizedGeneration !== this.generation
      || normalizedRequestId === null
      || !Number.isFinite(nowMs)
    ) return false;

    const requestSentAtMs = this.pendingHealthRequests.get(normalizedRequestId);
    if (
      !Number.isFinite(requestSentAtMs)
      || requestSentAtMs < this.startedAtMs
      || requestSentAtMs > nowMs
    ) return false;

    // Older requests are superseded for command freshness once a newer send
    // has been acknowledged. This also bounds correlation state if a server
    // rejects or loses an earlier report but later requests keep succeeding.
    for (const [pendingRequestId, sentAtMs] of this.pendingHealthRequests) {
      if (sentAtMs <= requestSentAtMs) this.pendingHealthRequests.delete(pendingRequestId);
    }
    this.lastAckAtMs = Math.max(this.lastAckAtMs, requestSentAtMs);
    return true;
  }

  status(nowMs) {
    if (!Number.isFinite(nowMs)) throw new Error('Publisher command observation time must be finite.');
    if (this.generation === null || !Number.isFinite(this.startedAtMs)) {
      return { fresh: false, reconnect: false, ackAgeMs: null };
    }
    const acknowledged = Number.isFinite(this.lastAckAtMs);
    const referenceAt = acknowledged ? this.lastAckAtMs : this.startedAtMs;
    const ageMs = Math.max(0, nowMs - referenceAt);
    return {
      fresh: acknowledged && ageMs < this.freshMs,
      reconnect: ageMs >= this.reconnectMs,
      ackAgeMs: acknowledged ? Math.round(ageMs) : null,
    };
  }
}
