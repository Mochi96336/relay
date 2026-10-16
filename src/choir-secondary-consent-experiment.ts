import { randomUUID } from 'node:crypto';

type AuthenticatedSocket = object & { participantId?: string };

export type ChoirConsentScope = Readonly<{
  roomEpoch: number;
  playbackRevision: number;
  videoId: string;
  backingGeneration: number;
  robotSourceGeneration: number;
}>;

type Invite = {
  inviteId: string;
  primaryId: string;
  secondaryId: string;
  /** Null for a join: B asked, A did not invite. */
  primarySocket: AuthenticatedSocket | null;
  consentSocket: AuthenticatedSocket | null;
  scope: ChoirConsentScope;
  expiresAtMs: number;
  accepted: boolean;
  /**
   * B joined whoever holds the Mic by pressing + Second Mic. Not bound to a
   * song or playback revision: it lasts while A holds the Mic and B's socket
   * stays open, across pauses, seeks and Takes, so the room can be created
   * as soon as a song plays and recreated after each seek.
   */
  join: boolean;
};

/**
 * Experimental, default-off consent control-plane only.
 * An invitation is NOT a capture ticket, Mic grant, playback-control grant,
 * or approval to create a Choir room. No public message can issue Media Epochs.
 *
 * Real participant identity comes from a server-authenticated socket,
 * never from a client-supplied participantId or a nickname.
 */
export class ChoirSecondaryConsentExperiment {
  private readonly pending = new Map<string, Invite>();
  private readonly ttlMs: number;

  constructor(private readonly policy: {
    scopeNow: (nowMs: number) => ChoirConsentScope | null;
    primaryStillOwnsMic: (id: string) => boolean;
    /**
     * Whether `id` still holds the Mic, through a reconnect grace. A join
     * follows the Mic owner, so a brief media or control hiccup must not end
     * it; only a new owner does. Defaults to primaryStillOwnsMic.
     */
    holdsMic?: (id: string) => boolean;
    participantConnected: (id: string) => boolean;
    takeFrozenNow: () => boolean;
    socketOpen: (socket: AuthenticatedSocket) => boolean;
    notifyParticipant: (id: string, payload: Record<string, unknown>) => void;
    notifySocket: (socket: AuthenticatedSocket, payload: Record<string, unknown>) => void;
  }, ttlMs = 30_000) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 60_000)
      throw new RangeError('Invalid Choir invitation TTL');
    this.ttlMs = ttlMs;
  }

  private sameScope(a: ChoirConsentScope, b: ChoirConsentScope) {
    return a.roomEpoch === b.roomEpoch
      && a.playbackRevision === b.playbackRevision
      && a.videoId === b.videoId
      && a.backingGeneration === b.backingGeneration
      && a.robotSourceGeneration === b.robotSourceGeneration;
  }

  private validInvite(invite: Invite, nowMs: number) {
    if (invite.join) {
      return Number.isFinite(nowMs) && nowMs >= 0
        && invite.consentSocket !== null && this.policy.socketOpen(invite.consentSocket)
        && (this.policy.holdsMic ?? this.policy.primaryStillOwnsMic)(invite.primaryId)
        && this.policy.participantConnected(invite.secondaryId);
    }
    const scope = this.policy.scopeNow(nowMs);
    return Number.isFinite(nowMs) && nowMs >= 0
      // Pending invitations expire quickly. Accepted consent persists for
      // the exact room until withdrawal, socket loss or authority change.
      && (invite.accepted || nowMs < invite.expiresAtMs)
      && scope !== null && this.sameScope(invite.scope, scope)
      && !this.policy.takeFrozenNow()
      && this.policy.primaryStillOwnsMic(invite.primaryId)
      && this.policy.participantConnected(invite.secondaryId)
      && invite.primarySocket !== null && this.policy.socketOpen(invite.primarySocket)
      && (!invite.accepted || (invite.consentSocket !== null
        && this.policy.socketOpen(invite.consentSocket)));
  }

  /**
   * Return a non-authoritative invite ID for B to explicitly acknowledge.
   * Duplicate same-room requests do not spray notification messages.
   */
  invite(primarySocket: AuthenticatedSocket, secondaryId: string, nowMs: number):
    string | null {
    this.sweep(nowMs);
    const primaryId = primarySocket.participantId;
    const scope = this.policy.scopeNow(nowMs);
    if (!primaryId || !this.policy.socketOpen(primarySocket)
      || !secondaryId || secondaryId === primaryId
      || !scope || !Number.isSafeInteger(scope.roomEpoch) || scope.roomEpoch < 1
      || !Number.isSafeInteger(scope.playbackRevision)
      || !this.policy.primaryStillOwnsMic(primaryId)
      || !this.policy.participantConnected(secondaryId)
      || this.policy.takeFrozenNow()) return null;

    const existing = [...this.pending.values()].find(p =>
      p.primaryId === primaryId && p.secondaryId === secondaryId);
    if (existing && this.sameScope(existing.scope, scope))
      return existing.inviteId;
    if (existing) this.pending.delete(existing.inviteId);
    // This is deliberately ONE outstanding secondary invitation per primary.
    for (const [id, p] of this.pending)
      if (p.primaryId === primaryId) {
        this.pending.delete(id);
        this.notifyRevoked(p, 'secondary-changed');
      }
    const invite: Invite = {
      inviteId: randomUUID(), primaryId, secondaryId, primarySocket,
      consentSocket: null, scope: { ...scope }, accepted: false,
      expiresAtMs: nowMs + this.ttlMs, join: false,
    };
    this.pending.set(invite.inviteId, invite);
    this.policy.notifyParticipant(secondaryId, {
      type: 'choir-secondary-invitation',
      inviteId: invite.inviteId, primaryId, roomEpoch: scope.roomEpoch,
      videoId: scope.videoId, expiresInMs: this.ttlMs,
    });
    return invite.inviteId;
  }

  /**
   * B joins the current Mic owner from its own authenticated socket. One
   * second singer per Mic owner: a different B is refused while one is in.
   * Returns false when nobody else holds the Mic.
   */
  join(secondarySocket: AuthenticatedSocket, primaryId: string | null, nowMs: number): boolean {
    this.sweep(nowMs);
    const secondaryId = secondarySocket.participantId;
    if (!secondaryId || !primaryId || secondaryId === primaryId
      || !this.policy.socketOpen(secondarySocket)
      || !this.policy.primaryStillOwnsMic(primaryId)
      || !this.policy.participantConnected(secondaryId)) return false;
    for (const invite of this.pending.values()) {
      if (invite.primaryId !== primaryId || !invite.accepted) continue;
      if (invite.secondaryId !== secondaryId) return false;
      if (invite.consentSocket === secondarySocket) return true;
    }
    for (const [id, invite] of this.pending)
      if (invite.primaryId === primaryId || invite.secondaryId === secondaryId) this.pending.delete(id);
    const joined: Invite = {
      inviteId: randomUUID(), primaryId, secondaryId, primarySocket: null,
      consentSocket: secondarySocket, accepted: true, join: true,
      scope: { roomEpoch: 0, playbackRevision: 0, videoId: '', backingGeneration: 0, robotSourceGeneration: 0 },
      expiresAtMs: Number.POSITIVE_INFINITY,
    };
    this.pending.set(joined.inviteId, joined);
    this.policy.notifySocket(secondarySocket, {
      type: 'choir-secondary-consent-status', status: 'accepted',
      secondaryId, primaryId, joined: true,
    });
    return true;
  }

  /** The joined pair, if a B is in: the server creates its room when a song plays. */
  activeJoin(nowMs: number): { primaryId: string; secondaryId: string } | null {
    this.sweep(nowMs);
    for (const invite of this.pending.values())
      if (invite.join) return { primaryId: invite.primaryId, secondaryId: invite.secondaryId };
    return null;
  }

  /**
   * B explicitly accepts or declines from its own authenticated socket.
   * The invite UUID is never sufficient proof of identity by itself.
   */
  respond(secondarySocket: AuthenticatedSocket, inviteId: string,
    accept: boolean, nowMs: number): boolean {
    this.sweep(nowMs);
    const invite = this.pending.get(inviteId);
    if (!invite || invite.join || !secondarySocket.participantId
      || secondarySocket.participantId !== invite.secondaryId
      || !this.policy.socketOpen(secondarySocket)
      || !this.validInvite(invite, nowMs)) return false;
    if (invite.accepted) {
      // Once B has consented, only its original physical socket can
      // explicitly withdraw. A stale decline from another B tab must not
      // remove the current consenting tab's authority.
      return accept && secondarySocket === invite.consentSocket;
    }
    if (!accept) {
      this.pending.delete(inviteId);
      if (invite.primarySocket) this.policy.notifySocket(invite.primarySocket, {
        type: 'choir-secondary-consent-status', status: 'declined',
        roomEpoch: invite.scope.roomEpoch, secondaryId: invite.secondaryId,
      });
      return true;
    }
    invite.accepted = true;
    invite.consentSocket = secondarySocket;
    if (invite.primarySocket) this.policy.notifySocket(invite.primarySocket, {
      type: 'choir-secondary-consent-status', status: 'accepted',
      roomEpoch: invite.scope.roomEpoch, secondaryId: invite.secondaryId,
    });
    this.policy.notifySocket(secondarySocket, {
      type: 'choir-secondary-consent-status', status: 'accepted',
      roomEpoch: invite.scope.roomEpoch, secondaryId: invite.secondaryId,
    });
    return true;
  }

  /** B can withdraw even while disconnected from the future media route. */
  withdraw(secondarySocket: AuthenticatedSocket, nowMs: number): boolean {
    const secondaryId = secondarySocket.participantId;
    if (!secondaryId || !this.policy.socketOpen(secondarySocket)) return false;
    let removed = false;
    for (const [id, invite] of this.pending) {
      if (invite.secondaryId !== secondaryId || !invite.accepted
        || invite.consentSocket !== secondarySocket) continue;
      this.pending.delete(id);
      removed = true;
      if (invite.primarySocket) this.policy.notifySocket(invite.primarySocket, {
        type: 'choir-secondary-consent-status', status: 'withdrawn',
        roomEpoch: invite.scope.roomEpoch, secondaryId,
      });
    }
    return removed;
  }

  /** Always check current scope, principal and live socket, even for reads. */
  hasConsent(primaryId: string, secondaryId: string,
    roomEpoch: number, nowMs: number): boolean {
    this.sweep(nowMs);
    return [...this.pending.values()].some(p => p.accepted
      && p.primaryId === primaryId && p.secondaryId === secondaryId
      && (p.join || p.scope.roomEpoch === roomEpoch)
      && this.validInvite(p, nowMs));
  }

  /**
   * Exact consent-bearing browser socket. A participant can have several
   * authenticated tabs; only the one that explicitly accepted can receive
   * the one-time secondary media claim. A shared nickname or participant
   * identity on a different socket does not silently opt that tab in.
   */
  hasConsentOnSocket(primaryId: string, secondaryId: string,
    roomEpoch: number, socket: AuthenticatedSocket, nowMs: number): boolean {
    return this.hasConsent(primaryId, secondaryId, roomEpoch, nowMs)
      && [...this.pending.values()].some(p => p.accepted
        && p.primaryId === primaryId && p.secondaryId === secondaryId
        && (p.join || p.scope.roomEpoch === roomEpoch)
        && p.consentSocket === socket
        && socket.participantId === secondaryId
        && this.validInvite(p, nowMs));
  }

  private notifyRevoked(invite: Invite, reason: string) {
    if (!invite.accepted) return;
    const notice = {
      type: 'choir-secondary-consent-status', status: 'revoked',
      reason, roomEpoch: invite.scope.roomEpoch,
      secondaryId: invite.secondaryId,
    };
    if (invite.primarySocket && this.policy.socketOpen(invite.primarySocket))
      this.policy.notifySocket(invite.primarySocket, notice);
    if (invite.consentSocket && this.policy.socketOpen(invite.consentSocket))
      this.policy.notifySocket(invite.consentSocket, notice);
  }

  /** Closing EITHER consenting socket permanently revokes the grant. */
  disconnected(socket: AuthenticatedSocket): boolean {
    let changed = false;
    for (const [id, p] of this.pending) {
      if (p.primarySocket !== socket && p.consentSocket !== socket) continue;
      this.pending.delete(id);
      this.notifyRevoked(p, 'connection-closed');
      changed = true;
    }
    return changed;
  }

  /** Bounded state: at most one invite per primary, stale entries removed. */
  sweep(nowMs: number): number {
    let removed = 0;
    for (const [id, p] of this.pending)
      if (!this.validInvite(p, nowMs)) {
        this.pending.delete(id);
        this.notifyRevoked(p, 'scope-or-authority-changed');
        removed++;
      }
    return removed;
  }

  get pendingCount() { return this.pending.size; }
}
