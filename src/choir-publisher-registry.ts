import { ChoirSession, type ChoirSeat } from './choir-session.js';

/**
 * Experimental authenticated-admission policy. The real server MUST first
 * establish participant identity from the existing private capability. A
 * client-supplied participantId alone is never proof of authorization.
 *
 * Every admitted transport gets a fresh server-owned mediaEpoch. A stale
 * socket/ticket cannot send under a replaced singer's new capture identity.
 */
export type ChoirAdmitRequest = {
  authenticatedParticipantId: string;
  transportId: string;
  seat: ChoirSeat;
  expectedPrimaryId?: string | null;
  nowMs: number;
};

export type ChoirAdmitResult =
  | {
      ok: true;
      mediaEpoch: number;
      resumed: boolean;
      revokedParticipantId: string | null;
    }
  | {
      ok: false;
      reason: 'invalid' | 'transport-in-use' | 'seat-rejected';
    };

type Admission = {
  participantId: string;
  transportId: string;
  mediaEpoch: number;
  connected: boolean;
  graceExpiresAt: number | null;
};

export class ChoirPublisherRegistry {
  private readonly admissions = new Map<string, Admission>();
  private readonly byTransport = new Map<string, string>();
  private nextMediaEpoch = 1;

  constructor(
    readonly seats: ChoirSession,
    private readonly graceMs: number,
  ) {
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw new RangeError('Invalid Choir reconnect grace.');
    }
  }

  admit(request: ChoirAdmitRequest): ChoirAdmitResult {
    const { authenticatedParticipantId: id, transportId, seat, nowMs } = request;
    if (!id || id !== id.trim() || !transportId || transportId !== transportId.trim()
      || !Number.isFinite(nowMs) || !['primary', 'secondary'].includes(seat)) {
      return { ok: false, reason: 'invalid' };
    }
    const transportOwner = this.byTransport.get(transportId);
    if (transportOwner && transportOwner !== id) {
      return { ok: false, reason: 'transport-in-use' };
    }

    const existing = this.admissions.get(id);
    if (existing?.connected && existing.transportId === transportId
      && this.seats.seatOf(id) === seat) {
      return {
        ok: true, mediaEpoch: existing.mediaEpoch,
        resumed: true, revokedParticipantId: null,
      };
    }

    const before = this.seats.primaryMicId;
    const action = seat === 'primary'
      ? this.seats.claimPrimary(id, request.expectedPrimaryId ?? null)
      : this.seats.joinSecondary(id);
    if (!action.ok) return { ok: false, reason: 'seat-rejected' };

    // Successful Take Mic makes the old primary's publisher inactive, but
    // unrelated secondary transports remain untouched.
    let revokedParticipantId: string | null = null;
    if (seat === 'primary' && before !== null && before !== id) {
      revokedParticipantId = before;
      const replaced = this.admissions.get(before);
      if (replaced) {
        this.byTransport.delete(replaced.transportId);
        this.admissions.delete(before);
      }
    }

    if (existing) this.byTransport.delete(existing.transportId);
    const admission: Admission = {
      participantId: id, transportId,
      mediaEpoch: this.nextMediaEpoch++,
      connected: true, graceExpiresAt: null,
    };
    this.admissions.set(id, admission);
    this.byTransport.set(transportId, id);
    return {
      ok: true, mediaEpoch: admission.mediaEpoch,
      resumed: Boolean(existing), revokedParticipantId,
    };
  }

  /**
   * A control/media socket close starts its *own* grace; it cannot release
   * another singer. Closing a superseded transport does nothing.
   */
  disconnect(transportId: string, nowMs: number): boolean {
    if (!Number.isFinite(nowMs)) return false;
    const id = this.byTransport.get(transportId);
    const entry = id ? this.admissions.get(id) : null;
    if (!entry || entry.transportId !== transportId || !entry.connected) return false;
    entry.connected = false;
    entry.graceExpiresAt = nowMs + this.graceMs;
    return true;
  }

  /** Explicit release and sender revocation; never a Mic promotion. */
  release(authenticatedParticipantId: string): boolean {
    const entry = this.admissions.get(authenticatedParticipantId);
    if (!entry) return false;
    this.byTransport.delete(entry.transportId);
    this.admissions.delete(authenticatedParticipantId);
    this.seats.leaveSinger(authenticatedParticipantId);
    return true;
  }

  /** Grace expiry cannot transfer Mic or song ownership automatically. */
  sweep(nowMs: number): string[] {
    const released: string[] = [];
    for (const [id, entry] of this.admissions) {
      if (!entry.connected && entry.graceExpiresAt !== null && nowMs >= entry.graceExpiresAt) {
        if (this.release(id)) released.push(id);
      }
    }
    return released;
  }

  mayAcceptMedia(
    authenticatedParticipantId: string,
    transportId: string,
    mediaEpoch: number,
  ): boolean {
    const entry = this.admissions.get(authenticatedParticipantId);
    return Boolean(entry && entry.connected && entry.transportId === transportId
      && entry.mediaEpoch === mediaEpoch && this.seats.seatOf(authenticatedParticipantId));
  }

  snapshot() {
    return [...this.admissions.values()].map(x => ({ ...x }));
  }
}
