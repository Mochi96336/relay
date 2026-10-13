import { ChoirDeadlineRoomExperiment, type ChoirDeadlineRoomOptions } from './choir-deadline-room-experiment.js';
import type { ChoirSeat } from './choir-session.js';
import type { PcmFrame } from './pcm-frame.js';

/** PRIVATE offline control-plane contract. Identity comes from server auth,
 * NOT a username, socket message, or stale client room token.
 *
 * Shadow observation deliberately does not call this class. The future
 * production adapter must separately verify SongSession, Robot source, Take
 * freeze, user role and backing generation before granting a new room.
 */
export type FreshChoirRoomSpec = Omit<ChoirDeadlineRoomOptions,
  'firstMediaEpoch' | 'songEpoch' | 'backingGeneration' | 'videoId' | 'roomEpochMs'> & {
  roomEpoch: number;
  songEpoch: number;
  backingGeneration: number;
  videoId: string;
  roomEpochMs: number;
  mappingEpoch: number;
  primaryId: string;
  secondaryId: string;
};

export type ChoirFreshCaptureTicket = Readonly<{
  roomEpoch: number; songEpoch: number; participantId: string;
  seat: ChoirSeat; transportId: string; mediaEpoch: number;
}>;

type Current = {
  room: ChoirDeadlineRoomExperiment;
  spec: FreshChoirRoomSpec;
  tickets: Map<string, ChoirFreshCaptureTicket>;
  contentVerified: Set<string>;
};

export type ChoirFreshRoomSnapshot = {
  state: 'idle' | 'awaiting-primary' | 'awaiting-secondary' | 'awaiting-content' | 'retired';
  roomEpoch: number | null;
  songEpoch: number | null;
  primaryId: string | null;
  secondaryId: string | null;
  admittedIds: string[];
  contentVerifiedIds: string[];
};

export class ChoirFreshRoomHandshakeExperiment {
  private current: Current | null = null;
  private lastRoomEpoch = 0;
  private lastSongEpoch = 0;
  private nextMediaEpoch = 1;
  private retired = false;

  /**
   * Called after an explicit trusted song/Robot restart decision.
   * At most one room is active. The prior room must be retired; receiving a
   * normal PLAYING heartbeat is never sufficient to call this automatically.
   */
  beginTrustedRoom(spec: FreshChoirRoomSpec): boolean {
    if (this.current || !Number.isSafeInteger(spec.roomEpoch)
      || spec.roomEpoch <= this.lastRoomEpoch
      || !Number.isSafeInteger(spec.songEpoch)
      || spec.songEpoch <= this.lastSongEpoch
      || !Number.isSafeInteger(spec.mappingEpoch) || spec.mappingEpoch < 1
      || !Number.isSafeInteger(spec.backingGeneration) || spec.backingGeneration < 0
      || !Number.isFinite(spec.roomEpochMs) || spec.roomEpochMs < 0
      || !/^[A-Za-z0-9_-]{11}$/.test(spec.videoId)
      || !spec.primaryId || spec.primaryId !== spec.primaryId.trim()
      || !spec.secondaryId || spec.secondaryId !== spec.secondaryId.trim()
      || spec.primaryId === spec.secondaryId) return false;
    const room = new ChoirDeadlineRoomExperiment({
      ...spec, firstMediaEpoch: this.nextMediaEpoch,
    });
    if (!room.setTrustedPlaybackMapping({
      mappingEpoch: spec.mappingEpoch, videoId: spec.videoId,
      songEpoch: spec.songEpoch, backingGeneration: spec.backingGeneration,
      robotCaptureGeneration: spec.backingGeneration,
      playbackRate: 1, playing: true,
    }, spec.roomEpochMs)) return false;
    this.lastRoomEpoch = spec.roomEpoch;
    this.lastSongEpoch = spec.songEpoch;
    this.retired = false;
    this.current = {
      room, spec: { ...spec }, tickets: new Map(), contentVerified: new Set(),
    };
    return true;
  }

  /** One verified transport and one newly minted Media Epoch per singer. */
  admitVerifiedSinger(request: {
    roomEpoch: number; songEpoch: number; verifiedParticipantId: string;
    transportId: string; nowMs: number;
  }): ChoirFreshCaptureTicket | null {
    const c = this.current;
    if (!c || request.roomEpoch !== c.spec.roomEpoch
      || request.songEpoch !== c.spec.songEpoch
      || !Number.isFinite(request.nowMs)
      || c.tickets.has(request.verifiedParticipantId)
      || !request.transportId || request.transportId !== request.transportId.trim())
      return null;
    const isPrimary = request.verifiedParticipantId === c.spec.primaryId;
    const isSecondary = request.verifiedParticipantId === c.spec.secondaryId;
    if (!isPrimary && !isSecondary) return null;
    if (isSecondary && !c.tickets.has(c.spec.primaryId)) return null;
    const seat: ChoirSeat = isPrimary ? 'primary' : 'secondary';
    const admitted = c.room.admitTrusted({
      verifiedParticipantId: request.verifiedParticipantId,
      transportId: request.transportId,
      seat, expectedPrimaryId: isPrimary ? null : c.spec.primaryId,
      nowMs: request.nowMs,
    });
    this.nextMediaEpoch = Math.max(this.nextMediaEpoch, c.room.nextUnissuedMediaEpoch);
    if (!admitted.ok || admitted.idempotent) return null;
    const ticket: ChoirFreshCaptureTicket = Object.freeze({
      roomEpoch: c.spec.roomEpoch, songEpoch: c.spec.songEpoch,
      participantId: request.verifiedParticipantId, transportId: request.transportId,
      seat, mediaEpoch: admitted.mediaEpoch,
    });
    c.tickets.set(request.verifiedParticipantId, ticket);
    return ticket;
  }

  private matches(t: ChoirFreshCaptureTicket): Current | null {
    const c = this.current;
    const issued = c?.tickets.get(t.participantId);
    return c && issued && issued.roomEpoch === t.roomEpoch
      && issued.songEpoch === t.songEpoch
      && issued.transportId === t.transportId
      && issued.mediaEpoch === t.mediaEpoch
      && issued.seat === t.seat ? c : null;
  }

  receiveVerifiedMic(
    ticket: ChoirFreshCaptureTicket, frame: PcmFrame,
    sampleRate: number, nowMs: number,
  ): boolean {
    const c = this.matches(ticket);
    return Boolean(c && c.room.receiveFromTransport(
      ticket.transportId, frame, sampleRate, nowMs,
    ));
  }

  receiveTrustedRobot(
    roomEpoch: number, songEpoch: number, frame: PcmFrame,
    sampleRate: number, nowMs: number,
  ): boolean {
    const c = this.current;
    return Boolean(c && c.spec.roomEpoch === roomEpoch
      && c.spec.songEpoch === songEpoch
      && c.room.receiveTrustedBacking(frame, sampleRate, nowMs));
  }

  /**
   * Only the server's internally collected 6s Mic/Robot PCM Content result
   * may unblock a fresh capture. Neither an old lag nor a client decision
   * is accepted as an argument.
   */
  analyzeFreshContent(
    ticket: ChoirFreshCaptureTicket, startSample: number, nowMs: number,
  ) {
    const c = this.matches(ticket);
    if (!c) return { status: 'rejected' as const, reason: 'old-or-unauthorized-ticket' };
    return c.room.analyzeTrustedCanonicalContent(
      ticket.transportId, ticket.mediaEpoch, startSample, nowMs,
    );
  }

  commitFreshContent(ticket: ChoirFreshCaptureTicket, nowMs: number, takeFrozen: boolean):
    boolean {
    const c = this.matches(ticket);
    if (!c || c.contentVerified.has(ticket.participantId)) return false;
    const result = c.room.commitTrustedCanonicalContent(
      ticket.transportId, ticket.mediaEpoch, nowMs, takeFrozen,
    );
    if (result !== 'applied') return false;
    c.contentVerified.add(ticket.participantId);
    return true;
  }

  /** Losing the primary does NOT change the secondary's seat. */
  disconnectVerifiedSinger(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    const c = this.matches(ticket);
    if (!c || !c.room.disconnectTransport(ticket.transportId, nowMs)) return false;
    // This first-version restart handshake does not rebind same-room
    // tickets. A disconnected singer must get a fresh Media Epoch in a
    // separate, already tested capture-rebind path.
    c.tickets.delete(ticket.participantId);
    c.contentVerified.delete(ticket.participantId);
    return true;
  }

  /**
   * Called by the trusted Robot/SongSession authority on discontinuity.
   * Old room objects and its six-second proof cache are discarded, and the
   * next beginTrustedRoom must use strictly larger Room+Song+Media Epochs.
   */
  retireTrustedRoom(roomEpoch: number, nowMs: number): boolean {
    const c = this.current;
    if (!c || c.spec.roomEpoch !== roomEpoch) return false;
    c.room.invalidateTrustedPlaybackAuthority(nowMs);
    this.nextMediaEpoch = Math.max(this.nextMediaEpoch, c.room.nextUnissuedMediaEpoch);
    this.current = null;
    this.retired = true;
    return true;
  }

  snapshot(): ChoirFreshRoomSnapshot {
    const c = this.current;
    const admittedIds = c ? [...c.tickets.keys()] : [];
    return {
      state: !c ? this.retired ? 'retired' : 'idle'
        : !c.tickets.has(c.spec.primaryId) ? 'awaiting-primary'
        : !c.tickets.has(c.spec.secondaryId) ? 'awaiting-secondary'
        : 'awaiting-content',
      roomEpoch: c?.spec.roomEpoch ?? null,
      songEpoch: c?.spec.songEpoch ?? null,
      primaryId: c?.spec.primaryId ?? null,
      secondaryId: c?.spec.secondaryId ?? null,
      admittedIds,
      contentVerifiedIds: c ? [...c.contentVerified] : [],
    };
  }
}
