const UINT32_MAX = 0xffff_ffff;

function uint32(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= UINT32_MAX
    ? number >>> 0
    : null;
}

export class PublisherHealthRequestCorrelation {
  constructor({ maxPending = 8 } = {}) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1) {
      throw new Error('Publisher health maxPending must be a positive safe integer.');
    }
    this.maxPending = maxPending;
    this.nextRequestId = 1;
    this.pending = new Map();
  }

  reset() {
    this.pending.clear();
  }

  issue({ socket, sessionEpoch, generation, sentAtMs }) {
    const normalizedGeneration = uint32(generation);
    if (!socket || normalizedGeneration === null || !Number.isFinite(sentAtMs)) {
      throw new Error('Publisher health correlation requires socket, uint32 generation, and finite send time.');
    }

    let requestId = this.nextRequestId >>> 0;
    for (let attempts = 0; this.pending.has(requestId) && attempts <= this.maxPending; attempts += 1) {
      requestId = (requestId + 1) >>> 0;
    }
    this.nextRequestId = (requestId + 1) >>> 0;
    this.pending.set(requestId, {
      socket,
      sessionEpoch,
      generation: normalizedGeneration,
      sentAtMs,
    });

    while (this.pending.size > this.maxPending) {
      const oldestRequestId = this.pending.keys().next().value;
      this.pending.delete(oldestRequestId);
    }
    return requestId;
  }

  forget(requestId) {
    const normalizedRequestId = uint32(requestId);
    return normalizedRequestId === null ? false : this.pending.delete(normalizedRequestId);
  }

  consume({ requestId, socket, sessionEpoch, generation }) {
    const normalizedRequestId = uint32(requestId);
    const normalizedGeneration = uint32(generation);
    if (normalizedRequestId === null || normalizedGeneration === null) return null;

    const pending = this.pending.get(normalizedRequestId);
    if (!pending) return null;
    this.pending.delete(normalizedRequestId);
    if (
      pending.socket !== socket
      || pending.sessionEpoch !== sessionEpoch
      || pending.generation !== normalizedGeneration
    ) return null;
    return pending.sentAtMs;
  }
}
