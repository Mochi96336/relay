/**
 * Experimental choir seating/authority policy. No production path imports this yet.
 *
 * A primary microphone is an explicit seat, NOT a parent transport of secondary
 * microphones. Losing the primary never promotes, releases, or invalidates a
 * secondary. The song controller is a separate authority.
 */
export type ChoirSeat = 'primary' | 'secondary';

export type ChoirSnapshot = {
  revision: number;
  primaryMicId: string | null;
  secondaryMicIds: string[];
  songControllerId: string | null;
  singerIds: string[];
  maxSingers: number;
};

export type ChoirActionResult =
  | { ok: true; changed: boolean }
  | {
    ok: false;
    changed: false;
    reason: 'invalid-participant' | 'primary-changed' | 'primary-required'
      | 'already-primary' | 'room-full' | 'controller-changed';
  };

function validParticipantId(id: string | null): id is string {
  return typeof id === 'string' && id.trim().length > 0 && id === id.trim();
}

export class ChoirSession {
  private readonly secondary = new Set<string>();
  private primary: string | null = null;
  private controller: string | null = null;
  private revisionValue = 0;

  constructor(readonly maxSingers = 2) {
    if (!Number.isSafeInteger(maxSingers) || maxSingers < 2) {
      throw new RangeError('Choir requires at least two singer seats.');
    }
  }

  get revision() {
    return this.revisionValue;
  }

  get primaryMicId() {
    return this.primary;
  }

  get songControllerId() {
    return this.controller;
  }

  seatOf(participantId: string): ChoirSeat | null {
    if (this.primary === participantId) return 'primary';
    return this.secondary.has(participantId) ? 'secondary' : null;
  }

  snapshot(): ChoirSnapshot {
    const secondaryMicIds = [...this.secondary];
    return {
      revision: this.revisionValue,
      primaryMicId: this.primary,
      secondaryMicIds,
      songControllerId: this.controller,
      singerIds: this.primary === null ? secondaryMicIds : [this.primary, ...secondaryMicIds],
      maxSingers: this.maxSingers,
    };
  }

  /**
   * Explicit Take Mic / Take Over action. A stale confirmation cannot displace
   * a different primary. The previous primary exits; existing secondaries stay.
   *
   * Only a user's explicit call can turn a secondary into the primary. This
   * method is NEVER called by disconnect/reconnect grace expiry.
   */
  claimPrimary(participantId: string, expectedPrimaryId: string | null): ChoirActionResult {
    if (!validParticipantId(participantId)) {
      return { ok: false, changed: false, reason: 'invalid-participant' };
    }
    if (this.primary !== expectedPrimaryId) {
      return { ok: false, changed: false, reason: 'primary-changed' };
    }
    if (this.primary === participantId) return { ok: true, changed: false };
    const alreadySecondary = this.secondary.has(participantId);
    if (this.primary === null && !alreadySecondary && this.secondary.size >= this.maxSingers) {
      return { ok: false, changed: false, reason: 'room-full' };
    }

    // Replacing one primary does not create a new singer seat.
    this.secondary.delete(participantId);
    this.primary = participantId;
    // First singer establishes the controller. Subsequent Mic role changes
    // never silently transfer a healthy song controller.
    if (this.controller === null) this.controller = participantId;
    this.revisionValue++;
    return { ok: true, changed: true };
  }

  /** Join without taking the existing primary's Mic or song authority. */
  joinSecondary(participantId: string): ChoirActionResult {
    if (!validParticipantId(participantId)) {
      return { ok: false, changed: false, reason: 'invalid-participant' };
    }
    if (this.primary === null) {
      return { ok: false, changed: false, reason: 'primary-required' };
    }
    if (this.primary === participantId) {
      return { ok: false, changed: false, reason: 'already-primary' };
    }
    if (this.secondary.has(participantId)) return { ok: true, changed: false };
    if (this.secondary.size + 1 >= this.maxSingers) {
      return { ok: false, changed: false, reason: 'room-full' };
    }
    this.secondary.add(participantId);
    this.revisionValue++;
    return { ok: true, changed: true };
  }

  /**
   * Called on explicit release or AFTER the external transport grace expires.
   * Does not promote a secondary, stop other media, or transfer song control.
   */
  leaveSinger(participantId: string): ChoirActionResult {
    if (!validParticipantId(participantId)) {
      return { ok: false, changed: false, reason: 'invalid-participant' };
    }
    const wasPrimary = this.primary === participantId;
    if (wasPrimary) this.primary = null;
    const wasSecondary = this.secondary.delete(participantId);
    if (!wasPrimary && !wasSecondary) return { ok: true, changed: false };
    this.revisionValue++;
    return { ok: true, changed: true };
  }

  /** A separately authorized song-control handoff, never a Mic side effect. */
  setSongController(participantId: string | null, expectedControllerId: string | null): ChoirActionResult {
    if (participantId !== null && !validParticipantId(participantId)) {
      return { ok: false, changed: false, reason: 'invalid-participant' };
    }
    if (this.controller !== expectedControllerId) {
      return { ok: false, changed: false, reason: 'controller-changed' };
    }
    if (this.controller === participantId) return { ok: true, changed: false };
    this.controller = participantId;
    this.revisionValue++;
    return { ok: true, changed: true };
  }
}
