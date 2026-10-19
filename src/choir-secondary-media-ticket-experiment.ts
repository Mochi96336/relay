import { randomBytes, randomUUID } from 'node:crypto';
import type { ChoirSecondaryPcmIngressExperiment } from './choir-secondary-pcm-ingress-experiment.js';

type ChoirSocket = object & { participantId?: string; role: string };
type Claim = {
  token: string;
  secondaryId: string;
  /** The socket B joined from, which asked for this claim. */
  joinSocket: ChoirSocket;
  expiresAtMs: number;
};

/**
 * Hands B's media socket its one grant. B's join socket asks for an opaque,
 * short-lived, single-use claim; only a distinct, freshly authenticated media
 * socket of the same participant may redeem it, and that redemption binds the
 * socket to B's voice in the ingress.
 *
 * Claim tokens travel only over B's own authenticated sockets. The browser
 * never names a seat or transport: the server generates the transport id
 * after every check has passed.
 */
export class ChoirSecondaryMediaTicketExperiment {
  private readonly pending = new Map<string, Claim>();

  constructor(
    private readonly ingress: Pick<ChoirSecondaryPcmIngressExperiment, 'bind'>,
    private readonly socketOpen: (socket: ChoirSocket) => boolean,
    /** Whether this socket is B's join socket and B may be heard now. */
    private readonly claimAllowed: (joinSocket: ChoirSocket, nowMs: number) => boolean,
    private readonly claimTtlMs = 15_000,
  ) {
    if (!Number.isSafeInteger(claimTtlMs)
      || claimTtlMs < 1_000 || claimTtlMs > 60_000)
      throw new RangeError('Invalid Choir media claim lifetime');
  }

  private allows(claim: Pick<Claim, 'secondaryId' | 'joinSocket'>, nowMs: number) {
    return this.socketOpen(claim.joinSocket)
      && claim.joinSocket.participantId === claim.secondaryId
      && this.claimAllowed(claim.joinSocket, nowMs);
  }

  /** A claim for B's join socket, superseding any B has not redeemed. */
  issue(joinSocket: ChoirSocket, nowMs: number): { claimToken: string; expiresInMs: number } | null {
    if (!Number.isFinite(nowMs) || joinSocket.role !== 'unknown' || !joinSocket.participantId)
      return null;
    this.sweep(nowMs);
    const secondaryId = joinSocket.participantId;
    if (!this.allows({ secondaryId, joinSocket }, nowMs)) return null;
    for (const [key, previous] of this.pending)
      if (previous.secondaryId === secondaryId) this.pending.delete(key);
    const claim: Claim = {
      token: randomBytes(32).toString('hex'), secondaryId, joinSocket,
      expiresAtMs: nowMs + this.claimTtlMs,
    };
    this.pending.set(claim.token, claim);
    return { claimToken: claim.token, expiresInMs: this.claimTtlMs };
  }

  /**
   * Single-use redemption. B's media socket must be distinct from B's join
   * socket, authenticated as the same participant, still unregistered for
   * any Mic/Robot/monitor role, and open. Returns the server-generated
   * transport id the ingress bound it under.
   */
  redeem(mediaSocket: ChoirSocket, claimToken: string,
    sourceRate: number, packetVersion: 2 | 3, nowMs: number): { transportId: string } | null {
    if (!Number.isFinite(nowMs) || typeof claimToken !== 'string'
      || !/^[0-9a-f]{64}$/.test(claimToken)
      || !this.socketOpen(mediaSocket) || mediaSocket.role !== 'unknown'
      || !mediaSocket.participantId
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000
      // PCM v2 at any native rate, or Opus v3 (20 ms frames at 48 kHz only).
      || (packetVersion !== 2 && !(packetVersion === 3 && sourceRate === 48_000))) return null;
    this.sweep(nowMs);
    const claim = this.pending.get(claimToken);
    if (!claim) return null;
    // Burn any presented token first: no second socket may reuse it.
    this.pending.delete(claimToken);
    if (mediaSocket === claim.joinSocket
      || mediaSocket.participantId !== claim.secondaryId
      || !this.allows(claim, nowMs)) return null;
    const transportId = randomUUID();
    return this.ingress.bind(mediaSocket, claim.secondaryId, transportId, sourceRate, nowMs, packetVersion)
      ? { transportId } : null;
  }

  /** Closing B's join socket revokes its outstanding claims. */
  disconnected(joinSocket: ChoirSocket): number {
    let removed = 0;
    for (const [token, claim] of this.pending)
      if (claim.joinSocket === joinSocket) {
        this.pending.delete(token);
        removed++;
      }
    return removed;
  }

  /** Bounded storage: one pending token per B, none expired or orphaned. */
  sweep(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0;
    let removed = 0;
    for (const [token, claim] of this.pending) {
      if (nowMs < claim.expiresAtMs && this.allows(claim, nowMs)) continue;
      this.pending.delete(token);
      removed++;
    }
    return removed;
  }

  get pendingCount() { return this.pending.size; }
}
