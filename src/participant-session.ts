export type ParticipantSnapshot = {
  id: string;
  nickname: string;
  connected: boolean;
  joinedAt: number;
  lastSeenAt: number;
  reconnectingUntil: number | null;
};

export type ParticipantSessionSnapshot = {
  revision: number;
  micOwnerId: string | null;
  participants: ParticipantSnapshot[];
};

type ParticipantRecord = {
  id: string;
  nickname: string;
  connections: Set<string>;
  joinedAt: number;
  lastSeenAt: number;
  reconnectingUntil: number | null;
};

type MicResult = {
  ok: boolean;
  changed: boolean;
  ownerId: string | null;
  previousOwnerId: string | null;
  reason?: 'busy' | 'unknown-participant' | 'not-owner' | 'owner-changed';
};

export function normalizeParticipantId(value: unknown) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9_-]{8,128}$/.test(id) ? id : null;
}

export function normalizeNickname(value: unknown) {
  if (typeof value !== 'string') return null;
  const nickname = value.replace(/\s+/g, ' ').trim();
  if (!nickname) return null;
  return Array.from(nickname).slice(0, 32).join('');
}

/**
 * In-memory room state for one Relay process.
 *
 * Participant identity is intentionally ephemeral and unauthenticated. The
 * server owns only presence and the single microphone lease; it does not turn
 * display names into accounts. Multiple sockets may belong to one participant
 * (the presence socket plus publisher/monitor transport sockets), so presence
 * is connection-counted rather than equated with one WebSocket.
 */
export class ParticipantSession {
  private readonly participants = new Map<string, ParticipantRecord>();
  private readonly connectionOwners = new Map<string, string>();
  private revisionValue = 0;
  private micOwnerValue: string | null = null;

  constructor(readonly reconnectGraceMs = 5_000) {}

  get revision() {
    return this.revisionValue;
  }

  get micOwnerId() {
    return this.micOwnerValue;
  }

  attach(input: {
    connectionId: string;
    participantId: string;
    nickname: string;
    nowMs: number;
  }) {
    const participantId = normalizeParticipantId(input.participantId);
    const nickname = normalizeNickname(input.nickname);
    if (!participantId || !nickname) return false;

    const previousOwner = this.connectionOwners.get(input.connectionId);
    if (previousOwner && previousOwner !== participantId) {
      this.detach(input.connectionId, input.nowMs);
    }

    let record = this.participants.get(participantId);
    let visibleChanged = false;
    if (!record) {
      record = {
        id: participantId,
        nickname,
        connections: new Set(),
        joinedAt: input.nowMs,
        lastSeenAt: input.nowMs,
        reconnectingUntil: null,
      };
      this.participants.set(participantId, record);
      visibleChanged = true;
    } else {
      // A connection handshake proves liveness, not an intent to mutate the
      // display name. Stale tabs can reconnect with an older local nickname;
      // only the explicit participant-rename message is allowed to rename an
      // existing participant.
      if (record.connections.size === 0) visibleChanged = true;
      record.lastSeenAt = input.nowMs;
      record.reconnectingUntil = null;
    }

    record.connections.add(input.connectionId);
    record.lastSeenAt = input.nowMs;
    record.reconnectingUntil = null;
    this.connectionOwners.set(input.connectionId, participantId);
    if (visibleChanged) this.bump();
    return visibleChanged;
  }

  detach(connectionId: string, nowMs: number) {
    const participantId = this.connectionOwners.get(connectionId);
    if (!participantId) return false;
    this.connectionOwners.delete(connectionId);

    const record = this.participants.get(participantId);
    if (!record) return false;
    record.connections.delete(connectionId);
    record.lastSeenAt = nowMs;
    if (record.connections.size > 0) return false;

    record.reconnectingUntil = nowMs + this.reconnectGraceMs;
    this.bump();
    return true;
  }

  rename(participantId: string, nicknameValue: unknown, nowMs: number) {
    const nickname = normalizeNickname(nicknameValue);
    const record = this.participants.get(participantId);
    if (!record || !nickname || record.nickname === nickname) return false;
    record.nickname = nickname;
    record.lastSeenAt = nowMs;
    this.bump();
    return true;
  }

  acquireMic(participantId: string): MicResult {
    if (!this.participants.has(participantId)) {
      return this.result(false, false, null, 'unknown-participant');
    }
    if (this.micOwnerValue === participantId) {
      return this.result(true, false, this.micOwnerValue);
    }
    if (this.micOwnerValue !== null) {
      return this.result(false, false, this.micOwnerValue, 'busy');
    }

    const previousOwnerId = this.micOwnerValue;
    this.micOwnerValue = participantId;
    this.bump();
    return {
      ok: true,
      changed: true,
      ownerId: participantId,
      previousOwnerId,
    };
  }

  /**
   * Confirmed takeover is a compare-and-swap, not an unconditional steal.
   * The client confirms the owner it actually saw. If somebody else acquired
   * the mic between rendering and confirmation, the stale action is rejected.
   * If the observed owner released meanwhile, taking the now-free mic is safe.
   */
  takeoverMic(participantId: string, expectedOwnerId: string | null): MicResult {
    if (!this.participants.has(participantId)) {
      return this.result(false, false, this.micOwnerValue, 'unknown-participant');
    }
    if (this.micOwnerValue === participantId) {
      return this.result(true, false, this.micOwnerValue);
    }
    if (this.micOwnerValue !== null && this.micOwnerValue !== expectedOwnerId) {
      return this.result(false, false, this.micOwnerValue, 'owner-changed');
    }

    const previousOwnerId = this.micOwnerValue;
    this.micOwnerValue = participantId;
    this.bump();
    return {
      ok: true,
      changed: true,
      ownerId: participantId,
      previousOwnerId,
    };
  }

  releaseMic(participantId: string): MicResult {
    if (this.micOwnerValue !== participantId) {
      return this.result(false, false, this.micOwnerValue, 'not-owner');
    }
    const previousOwnerId = this.micOwnerValue;
    this.micOwnerValue = null;
    this.bump();
    return {
      ok: true,
      changed: true,
      ownerId: null,
      previousOwnerId,
    };
  }

  sweep(nowMs: number) {
    let changed = false;
    let releasedMicOwnerId: string | null = null;

    for (const [participantId, record] of this.participants) {
      if (record.connections.size > 0) continue;
      if (record.reconnectingUntil === null || nowMs < record.reconnectingUntil) continue;

      this.participants.delete(participantId);
      changed = true;
      if (this.micOwnerValue === participantId) {
        releasedMicOwnerId = participantId;
        this.micOwnerValue = null;
      }
    }

    if (changed) this.bump();
    return { changed, releasedMicOwnerId };
  }

  snapshot(): ParticipantSessionSnapshot {
    const participants = Array.from(this.participants.values())
      .map((record): ParticipantSnapshot => ({
        id: record.id,
        nickname: record.nickname,
        connected: record.connections.size > 0,
        joinedAt: record.joinedAt,
        lastSeenAt: record.lastSeenAt,
        reconnectingUntil: record.connections.size > 0 ? null : record.reconnectingUntil,
      }))
      .sort((a, b) => {
        if (a.id === this.micOwnerValue) return -1;
        if (b.id === this.micOwnerValue) return 1;
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        return a.joinedAt - b.joinedAt || a.id.localeCompare(b.id);
      });

    return {
      revision: this.revisionValue,
      micOwnerId: this.micOwnerValue,
      participants,
    };
  }

  participant(participantId: string) {
    const record = this.participants.get(participantId);
    if (!record) return null;
    return {
      id: record.id,
      nickname: record.nickname,
      connected: record.connections.size > 0,
    };
  }

  private bump() {
    this.revisionValue += 1;
  }

  private result(
    ok: boolean,
    changed: boolean,
    ownerId: string | null,
    reason?: MicResult['reason'],
  ): MicResult {
    return {
      ok,
      changed,
      ownerId,
      previousOwnerId: this.micOwnerValue,
      ...(reason ? { reason } : {}),
    };
  }
}
