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
  primarySocket: AuthenticatedSocket;
  consentSocket: AuthenticatedSocket | null;
  scope: ChoirConsentScope;
  expiresAtMs: number;
  accepted: boolean;
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
    const scope = this.policy.scopeNow(nowMs);
    return Number.isFinite(nowMs) && nowMs >= 0
      && nowMs < invite.expiresAtMs
      && scope !== null && this.sameScope(invite.scope, scope)
      && !this.policy.takeFrozenNow()
      && this.policy.primaryStillOwnsMic(invite.primaryId)
      && this.policy.participantConnected(invite.secondaryId)
      && this.policy.socketOpen(invite.primarySocket)
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
      if (p.primaryId === primaryId) this.pending.delete(id);
    const invite: Invite = {
      inviteId: randomUUID(), primaryId, secondaryId, primarySocket,
      consentSocket: null, scope: { ...scope }, accepted: false,
      expiresAtMs: nowMs + this.ttlMs,
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
   * B explicitly accepts or declines from its own authenticated socket.
   * The invite UUID is never sufficient proof of identity by itself.
   */
  respond(secondarySocket: AuthenticatedSocket, inviteId: string,
    accept: boolean, nowMs: number): boolean {
    this.sweep(nowMs);
    const invite = this.pending.get(inviteId);
    if (!invite || !secondarySocket.participantId
      || secondarySocket.participantId !== invite.secondaryId
      || !this.policy.socketOpen(secondarySocket)
      || !this.validInvite(invite, nowMs)) return false;
    if (!accept) {
      this.pending.delete(inviteId);
      this.policy.notifySocket(invite.primarySocket, {
        type: 'choir-secondary-consent-status', status: 'declined',
        roomEpoch: invite.scope.roomEpoch, secondaryId: invite.secondaryId,
      });
      return true;
    }
    if (invite.accepted) {
      // A retry from another B tab must not replace the consent-bearing socket.
      return secondarySocket === invite.consentSocket;
    }
    invite.accepted = true;
    invite.consentSocket = secondarySocket;
    this.policy.notifySocket(invite.primarySocket, {
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
      this.policy.notifySocket(invite.primarySocket, {
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
      && p.scope.roomEpoch === roomEpoch
      && this.validInvite(p, nowMs));
  }

  /** Closing EITHER consenting socket permanently revokes the grant. */
  disconnected(socket: AuthenticatedSocket): boolean {
    let changed = false;
    for (const [id, p] of this.pending) {
      if (p.primarySocket !== socket && p.consentSocket !== socket) continue;
      this.pending.delete(id);
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
        removed++;
      }
    return removed;
  }

  get pendingCount() { return this.pending.size; }
}
