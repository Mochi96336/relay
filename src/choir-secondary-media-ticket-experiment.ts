import { randomBytes, randomUUID } from 'node:crypto';
import type {
  ChoirRoomRestartCoordinatorExperiment,
  ChoirRestartPreview,
} from './choir-room-restart-coordinator-experiment.js';
import type { ChoirFreshCaptureTicket } from './choir-fresh-room-handshake-experiment.js';
import type { ChoirSecondaryConsentExperiment } from './choir-secondary-consent-experiment.js';
import type { ChoirSecondaryPcmIngressExperiment } from './choir-secondary-pcm-ingress-experiment.js';

type ChoirSocket = object & { participantId?: string; role: string };
type Claim = {
  token: string;
  primaryId: string;
  secondaryId: string;
  roomEpoch: number;
  songEpoch: number;
  consentSocket: ChoirSocket;
  expiresAtMs: number;
};

/**
 * PRIVATE, EXPERIMENTAL control->media join bridge.
 *
 * B's ACCEPT is intentionally not the actual media admission. First a
 * verified, consenting B control Socket receives an opaque short-lived
 * single-use claim. Only a distinct, freshly authenticated B media Socket
 * may redeem it; THAT exact operation creates the server-owned Media Epoch.
 *
 * The production server does NOT route a client message into this broker.
 * No raw client room/seat/Media Epoch claim is ever accepted.
 */
export class ChoirSecondaryMediaTicketExperiment {
  private readonly pending = new Map<string, Claim>();

  constructor(
    private readonly coordinator: Pick<ChoirRoomRestartCoordinatorExperiment,
      'observe' | 'preview' | 'admitVerifiedSinger'
      | 'retireFailedSecondaryBind'>,
    private readonly consent: Pick<ChoirSecondaryConsentExperiment, 'hasConsentOnSocket'>,
    private readonly ingress: Pick<ChoirSecondaryPcmIngressExperiment,
      'bindVerifiedSecondary'>,
    private readonly socketOpen: (socket: ChoirSocket) => boolean,
    private readonly claimTtlMs = 15_000,
  ) {
    if (!Number.isSafeInteger(claimTtlMs)
      || claimTtlMs < 1_000 || claimTtlMs > 60_000)
      throw new RangeError('Invalid Choir media claim lifetime');
  }

  private eligible(preview: ChoirRestartPreview) {
    return preview.roomEpoch !== null && preview.songEpoch !== null
      && preview.primaryId !== null && preview.secondaryId !== null
      && preview.primary !== 'join-required' && preview.primary !== null
      && preview.secondary === 'join-required'
      && preview.monitoring !== 'unavailable';
  }

  /**
   * This method is for server use after a trusted room CAS + verified A
   * admission. It never calls admitVerifiedSinger: issuing a claim therefore
   * cannot reserve a Media Epoch or make B audible.
   */
  issue(consentSocket: ChoirSocket, nowMs: number):
    { claimToken: string; roomEpoch: number; expiresInMs: number } | null {
    if (!Number.isFinite(nowMs) || !this.socketOpen(consentSocket)
      || consentSocket.role !== 'unknown' || !consentSocket.participantId)
      return null;
    this.sweep(nowMs);
    this.coordinator.observe(nowMs);
    const p = this.coordinator.preview();
    if (!this.eligible(p) || consentSocket.participantId !== p.secondaryId
      || !this.consent.hasConsentOnSocket(
        p.primaryId!, p.secondaryId!, p.roomEpoch!, consentSocket, nowMs,
      )) return null;
    // B may have only one unredeemed claim; superseding invalidates older
    // tokens without consuming an acoustic capture generation.
    for (const [key, previous] of this.pending)
      if (previous.secondaryId === p.secondaryId) this.pending.delete(key);
    const claim: Claim = {
      token: randomBytes(32).toString('hex'),
      primaryId: p.primaryId!, secondaryId: p.secondaryId!,
      roomEpoch: p.roomEpoch!, songEpoch: p.songEpoch!,
      consentSocket, expiresAtMs: nowMs + this.claimTtlMs,
    };
    this.pending.set(claim.token, claim);
    return {
      claimToken: claim.token, roomEpoch: claim.roomEpoch,
      expiresInMs: this.claimTtlMs,
    };
  }

  /**
   * Single-use redemption. B's media socket MUST be distinct from the B
   * consent socket, privately authenticated as the same participant, still
   * unregistered for any existing Mic/Robot/monitor role and open.
   *
   * Never accept roomEpoch, seat, transportId or mediaEpoch from the client.
   * A server-generated transportId is used only AFTER all checks pass.
   */
  redeem(mediaSocket: ChoirSocket, claimToken: string,
    sourceRate: number, packetVersion: 1 | 2, nowMs: number):
    ChoirFreshCaptureTicket | null {
    if (!Number.isFinite(nowMs) || typeof claimToken !== 'string'
      || !/^[0-9a-f]{64}$/.test(claimToken)
      || !this.socketOpen(mediaSocket) || mediaSocket.role !== 'unknown'
      || !mediaSocket.participantId
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000
      || packetVersion !== 2) return null;
    this.sweep(nowMs);
    const claim = this.pending.get(claimToken);
    if (!claim) return null;

    // Burn any presented token before room mutation: no second socket or
    // second concurrent registration can re-use the same claim.
    this.pending.delete(claimToken);
    if (mediaSocket === claim.consentSocket
      || mediaSocket.participantId !== claim.secondaryId
      || !this.socketOpen(claim.consentSocket)
      || !this.consent.hasConsentOnSocket(
        claim.primaryId, claim.secondaryId, claim.roomEpoch,
        claim.consentSocket, nowMs,
      )) return null;

    this.coordinator.observe(nowMs);
    const p = this.coordinator.preview();
    if (!this.eligible(p)
      || p.roomEpoch !== claim.roomEpoch || p.songEpoch !== claim.songEpoch
      || p.primaryId !== claim.primaryId || p.secondaryId !== claim.secondaryId)
      return null;

    const ticket = this.coordinator.admitVerifiedSinger({
      roomEpoch: claim.roomEpoch, songEpoch: claim.songEpoch,
      verifiedParticipantId: mediaSocket.participantId,
      transportId: randomUUID(), nowMs,
    });
    if (!ticket) return null;
    if (!this.ingress.bindVerifiedSecondary(
      mediaSocket, ticket, sourceRate, nowMs,
    )) {
      // The canonical N=2 seat is first-version non-rebindable. Removing
      // the ticket does NOT make that seat safely re-admittable; retire the
      // room and require a new explicit restart/CAS with fresh consent.
      this.coordinator.retireFailedSecondaryBind(ticket, nowMs);
      return null;
    }
    return ticket;
  }

  /** Control socket closure revokes all outstanding claims; media closes
   * through the ingress separately. No implicit primary promotion. */
  disconnected(controlSocket: ChoirSocket): number {
    let removed = 0;
    for (const [token, c] of this.pending)
      if (c.consentSocket === controlSocket) {
        this.pending.delete(token);
        removed++;
      }
    return removed;
  }

  /** Bound storage: one pending token per B and no expired/retired grants. */
  sweep(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0;
    this.coordinator.observe(nowMs);
    const p = this.coordinator.preview();
    let removed = 0;
    for (const [token, c] of this.pending) {
      if (nowMs < c.expiresAtMs && this.socketOpen(c.consentSocket)
        && this.eligible(p)
        && p.roomEpoch === c.roomEpoch && p.songEpoch === c.songEpoch
        && p.primaryId === c.primaryId && p.secondaryId === c.secondaryId
        && this.consent.hasConsentOnSocket(
          c.primaryId, c.secondaryId, c.roomEpoch, c.consentSocket, nowMs,
        )) continue;
      this.pending.delete(token);
      removed++;
    }
    return removed;
  }

  get pendingCount() { return this.pending.size; }
}
