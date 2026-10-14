import type { SongSession } from './song-session.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import { ChoirShadowLifecycleExperiment } from './choir-shadow-lifecycle-experiment.js';
import {
  ChoirFreshRoomHandshakeExperiment,
  type ChoirFreshCaptureTicket,
  type FreshChoirRoomSpec,
} from './choir-fresh-room-handshake-experiment.js';

/**
 * OFFLINE, private-only coordinator: joins the real authority witness and
 * the strict A/B capture handshake. Approval is deliberately supplied by
 * the SERVER, not inferred from a client participantId/primary claim.
 *
 * Production's default-off shadow passes an authorize callback that always
 * returns false; no WebSocket/WebTransport or PCM path invokes approval.
 */
export type ChoirRestartApproval = {
  actorParticipantId: string;
  primaryId: string;
  secondaryId: string;
  expectedRetiredRoomEpoch: number;
  expectedPlaybackRevision: number;
  nowMs: number;
};

type Authority = {
  videoId: string;
  revision: number;
  playbackRate: number;
  backingGeneration: number;
  robotSourceGeneration: number;
  leaderParticipantId: string;
  leaderTransportId: string;
};

export type ChoirRestartPreview = {
  state: 'awaiting-authority' | 'restart-required' | 'awaiting-primary'
    | 'awaiting-secondary' | 'awaiting-content' | 'partially-ready' | 'duet-ready';
  roomEpoch: number | null;
  songEpoch: number | null;
  videoId: string | null;
  primaryId: string | null;
  secondaryId: string | null;
  primary: 'join-required' | 'calibration-required' | 'ready' | null;
  secondary: 'join-required' | 'calibration-required' | 'ready' | null;
  /** Diagnostic plan only; no audio output, client notification or key. */
  monitoring: 'unavailable' | 'backing-only' | 'one-voice' | 'two-voices';
};

export class ChoirRoomRestartCoordinatorExperiment {
  private lastWitnessRoomEpoch = 0;
  private lastApprovedRoomEpoch = 0;
  private lastObservedMs = Number.NEGATIVE_INFINITY;
  private approved: {
    roomEpoch: number; songEpoch: number;
    videoId: string; primaryId: string; secondaryId: string;
  } | null = null;

  constructor(
    private readonly shadow: ChoirShadowLifecycleExperiment,
    private readonly songs: Pick<SongSession, 'statusPayload'>,
    private readonly robot: Pick<SourceRuntime<SourceRuntimeSocket>, 'connected' | 'generation'>,
    private readonly backingGenerationNow: () => number | null,
    private readonly serverAuthorizesRestart: (
      approval: ChoirRestartApproval, authority: Readonly<Authority>,
    ) => boolean,
    private readonly takeFrozenNow: () => boolean,
    private readonly config: Pick<FreshChoirRoomSpec,
      'sampleRate' | 'frameMs' | 'prebufferMs' | 'retentionMs'
      | 'contentHistoryMs' | 'outputHoldbackMs'>,
    private readonly handshake = new ChoirFreshRoomHandshakeExperiment(),
    // Fail closed unless the caller provides an explicit server-owned live
    // Mic-owner / B-consent check, re-evaluated on every media operation.
    private readonly roomRolesStillAuthorized: (primaryId: string, secondaryId: string, roomEpoch: number) => boolean
      = () => false,
  ) {}

  /**
   * Called after server-owned SongSession/SourceRuntime events, and each
   * periodic clock tick. An invalidated witness retires all old A/B tickets.
   * A later PLAYING heartbeat by itself can NEVER approve their replacement.
   */
  observe(nowMs: number): ChoirRestartPreview {
    if (!Number.isFinite(nowMs) || nowMs < this.lastObservedMs)
      return this.preview();
    this.lastObservedMs = nowMs;
    if (this.approved && (this.takeFrozenNow()
      || !this.roomRolesStillAuthorized(
        this.approved.primaryId, this.approved.secondaryId, this.approved.roomEpoch,
      ))) {
      // Revoked room permission MUST retire the Shadow witness as well.
      // Merely clearing Choir tickets leaves the old witness re-usable and
      // mislabels the room as "awaiting authority" instead of restart-required.
      this.shadow.retireForTrustRevocation(nowMs);
    }
    const observedBacking = this.backingGenerationNow();
    const witness = this.shadow.observe(nowMs, observedBacking);
    if (witness.state === 'shadow-active' && witness.roomEpoch !== null)
      this.lastWitnessRoomEpoch = Math.max(this.lastWitnessRoomEpoch, witness.roomEpoch);
    if (this.approved && (witness.state !== 'shadow-active'
      || witness.roomEpoch !== this.approved.roomEpoch
      || witness.songEpoch !== this.approved.songEpoch
      || witness.videoId !== this.approved.videoId
      || witness.backingGeneration === null
      || this.takeFrozenNow()
      || !this.roomRolesStillAuthorized(
        this.approved.primaryId, this.approved.secondaryId, this.approved.roomEpoch,
      ))) {
      this.handshake.retireTrustedRoom(this.approved.roomEpoch, nowMs);
      this.approved = null;
    }
    return this.preview();
  }

  private currentAuthority(nowMs: number): Authority | null {
    const status = this.songs.statusPayload(nowMs) as Record<string, unknown>;
    const backing = this.backingGenerationNow();
    if (!this.robot.connected()
      || !Number.isSafeInteger(this.robot.generation)
      || this.robot.generation < 0
      || !Number.isSafeInteger(backing) || backing === null || backing < 0
      || status.connected !== true || status.leaderConnected !== true
      || status.leaderFresh !== true || status.handoffState !== 'idle'
      || status.state !== 1
      || typeof status.videoId !== 'string'
      || !/^[A-Za-z0-9_-]{11}$/.test(status.videoId)
      || typeof status.playbackLeaderParticipantId !== 'string'
      || !status.playbackLeaderParticipantId
      || typeof status.playbackTransportId !== 'string'
      || !status.playbackTransportId
      || !Number.isSafeInteger(status.revision)
      || (status.revision as number) < 1
      || typeof status.playbackRate !== 'number'
      || !Number.isFinite(status.playbackRate)
      || status.playbackRate < .25 || status.playbackRate > 4) return null;
    return {
      videoId: status.videoId,
      revision: status.revision as number,
      playbackRate: status.playbackRate,
      backingGeneration: backing,
      robotSourceGeneration: this.robot.generation,
      leaderParticipantId: status.playbackLeaderParticipantId,
      leaderTransportId: status.playbackTransportId,
    };
  }

  /**
   * Explicit compare-and-swap. The SERVER's private admission/role policy
   * supplies the authorizer. An actor name or a stale approval request from
   * a client is not authorization. No production handler calls this method.
   */
  approveTrustedRestart(request: ChoirRestartApproval): boolean {
    if (!Number.isFinite(request.nowMs)
      || request.nowMs < this.lastObservedMs
      || !Number.isSafeInteger(request.expectedRetiredRoomEpoch)
      || request.expectedRetiredRoomEpoch !== this.lastApprovedRoomEpoch
      || !request.actorParticipantId
      || !request.primaryId || request.primaryId !== request.primaryId.trim()
      || !request.secondaryId || request.secondaryId !== request.secondaryId.trim()
      || request.primaryId === request.secondaryId
      || this.takeFrozenNow()
      || !this.roomRolesStillAuthorized(
        request.primaryId, request.secondaryId, request.expectedRetiredRoomEpoch + 1,
      )
      || this.approved !== null) return false;

    this.observe(request.nowMs);
    const witness = this.shadow.snapshot();
    if (witness.state !== 'shadow-active' && witness.state !== 'restart-required')
      return false;
    const authority = this.currentAuthority(request.nowMs);
    if (!authority
      || authority.revision !== request.expectedPlaybackRevision
      || !this.serverAuthorizesRestart(request, authority)) return false;

    let roomEpoch: number, songEpoch: number;
    if (witness.state === 'shadow-active') {
      // Only the first room can adopt an already-active Shadow witness.
      // Once an approved room has retired, a new witness must be created
      // THROUGH this coordinator's explicit CAS, not rearmed out-of-band.
      if (this.lastApprovedRoomEpoch !== 0) return false;
      if (witness.roomEpoch === null || witness.songEpoch === null
        || witness.videoId !== authority.videoId
        || witness.backingGeneration !== authority.backingGeneration
        || witness.roomEpoch <= this.lastApprovedRoomEpoch) return false;
      roomEpoch = witness.roomEpoch;
      songEpoch = witness.songEpoch;
    } else {
      if (this.lastWitnessRoomEpoch <= 0) return false;
      roomEpoch = this.lastWitnessRoomEpoch + 1;
      songEpoch = roomEpoch;
      if (!Number.isSafeInteger(roomEpoch)
        || !this.shadow.authorizeExplicitFreshRoom(
          this.lastWitnessRoomEpoch, roomEpoch, songEpoch,
        )) return false;
      const refreshed = this.shadow.observe(request.nowMs, authority.backingGeneration);
      if (refreshed.state !== 'shadow-active'
        || refreshed.roomEpoch !== roomEpoch
        || refreshed.songEpoch !== songEpoch
        || refreshed.backingGeneration !== authority.backingGeneration
        || refreshed.videoId !== authority.videoId) return false;
      this.lastWitnessRoomEpoch = roomEpoch;
    }

    const spec: FreshChoirRoomSpec = {
      ...this.config, roomEpoch, songEpoch, roomEpochMs: request.nowMs,
      backingGeneration: authority.backingGeneration,
      videoId: authority.videoId, mappingEpoch: authority.revision,
      playbackRate: authority.playbackRate,
      primaryId: request.primaryId, secondaryId: request.secondaryId,
    };
    if (!this.handshake.beginTrustedRoom(spec)) return false;
    this.lastApprovedRoomEpoch = roomEpoch;
    this.approved = {
      roomEpoch, songEpoch, videoId: authority.videoId,
      primaryId: request.primaryId, secondaryId: request.secondaryId,
    };
    return true;
  }

  /** Called only AFTER existing private participant/transport verification. */
  admitVerifiedSinger(request: {
    roomEpoch: number; songEpoch: number;
    verifiedParticipantId: string; transportId: string; nowMs: number;
  }): ChoirFreshCaptureTicket | null {
    this.observe(request.nowMs);
    if (!this.approved || this.approved.roomEpoch !== request.roomEpoch
      || this.approved.songEpoch !== request.songEpoch) return null;
    return this.handshake.admitVerifiedSinger(request);
  }

  /**
   * These private media/proof gates always re-observe the live server-owned
   * SongSession and Robot authority BEFORE accepting a packet or proof.
   * A seek between clock ticks therefore cannot leak into a new room.
   * They are not connected to any production Mic/Robot transport.
   */
  private currentTicket(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    this.observe(nowMs);
    return Boolean(this.approved
      && ticket.roomEpoch === this.approved.roomEpoch
      && ticket.songEpoch === this.approved.songEpoch
      && (ticket.participantId === this.approved.primaryId
        || ticket.participantId === this.approved.secondaryId));
  }

  /**
   * Private binding preflight: no media routing unless this exact capture
   * still belongs to the active authenticated room and transport registry.
   */
  mayAcceptVerifiedTicket(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    return this.currentTicket(ticket, nowMs)
      && this.handshake.hasVerifiedTicket(ticket);
  }

  receiveVerifiedMic(
    ticket: ChoirFreshCaptureTicket,
    frame: import('./pcm-frame.js').PcmFrame,
    sampleRate: number, nowMs: number,
  ): boolean {
    return this.currentTicket(ticket, nowMs)
      && this.handshake.receiveVerifiedMic(ticket, frame, sampleRate, nowMs);
  }

  receiveTrustedRobot(
    roomEpoch: number, songEpoch: number,
    frame: import('./pcm-frame.js').PcmFrame,
    sampleRate: number, nowMs: number,
  ): boolean {
    this.observe(nowMs);
    return Boolean(this.approved && this.approved.roomEpoch === roomEpoch
      && this.approved.songEpoch === songEpoch
      && this.handshake.receiveTrustedRobot(
        roomEpoch, songEpoch, frame, sampleRate, nowMs,
      ));
  }

  analyzeFreshContent(
    ticket: ChoirFreshCaptureTicket, startSample: number, nowMs: number,
  ) {
    if (!this.currentTicket(ticket, nowMs))
      return { status: 'rejected' as const, reason: 'retired-room-or-stale-authority' };
    return this.handshake.analyzeFreshContent(ticket, startSample, nowMs);
  }

  commitFreshContent(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    return this.currentTicket(ticket, nowMs)
      && !this.takeFrozenNow()
      && this.handshake.commitFreshContent(ticket, nowMs, false);
  }

  disconnectVerifiedSinger(ticket: ChoirFreshCaptureTicket, nowMs: number): boolean {
    return this.currentTicket(ticket, nowMs)
      && this.handshake.disconnectVerifiedSinger(ticket, nowMs);
  }

  /** Offline scheduler discards PCM; no monitor output is emitted. */
  advanceDue(roomEpoch: number, nowMs: number): boolean {
    this.observe(nowMs);
    return Boolean(this.approved && this.approved.roomEpoch === roomEpoch
      && this.handshake.advanceDue(roomEpoch, nowMs));
  }

  /** Proof-only diagnostic; never grants Media Epoch or acoustic authority. */
  previewForVerifiedSinger(participantId: string): {
    roomEpoch: number; songEpoch: number; videoId: string;
    seat: 'primary' | 'secondary'; stage: 'join-required' | 'calibration-required' | 'ready';
  } | null {
    const a = this.approved;
    if (!a || (participantId !== a.primaryId && participantId !== a.secondaryId))
      return null;
    const preview = this.preview();
    return {
      roomEpoch: a.roomEpoch, songEpoch: a.songEpoch, videoId: a.videoId,
      seat: participantId === a.primaryId ? 'primary' : 'secondary',
      stage: (participantId === a.primaryId ? preview.primary : preview.secondary)
        ?? 'join-required',
    };
  }

  /** Authoritative room discontinuity; no transport auto-promotion. */
  preview(): ChoirRestartPreview {
    if (!this.approved) {
      return {
        state: this.shadow.snapshot().state === 'restart-required'
          ? 'restart-required' : 'awaiting-authority',
        roomEpoch: null, songEpoch: null, videoId: null,
        primaryId: null, secondaryId: null,
        primary: null, secondary: null, monitoring: 'unavailable',
      };
    }
    const snap = this.handshake.snapshot();
    const a = this.approved;
    const status = (id: string) => !snap.admittedIds.includes(id)
      ? 'join-required' as const : snap.contentVerifiedIds.includes(id)
        ? 'ready' as const : 'calibration-required' as const;
    const primary = status(a.primaryId);
    const secondary = status(a.secondaryId);
    const readyCount = Number(primary === 'ready') + Number(secondary === 'ready');
    return {
      state: readyCount === 2 ? 'duet-ready'
        : readyCount === 1 ? 'partially-ready'
          : snap.state === 'awaiting-primary' ? 'awaiting-primary'
            : snap.state === 'awaiting-secondary' ? 'awaiting-secondary'
              : 'awaiting-content',
      roomEpoch: a.roomEpoch, songEpoch: a.songEpoch, videoId: a.videoId,
      primaryId: a.primaryId, secondaryId: a.secondaryId,
      primary, secondary,
      monitoring: readyCount === 2 ? 'two-voices'
        : readyCount === 1 ? 'one-voice' : 'backing-only',
    };
  }

}
