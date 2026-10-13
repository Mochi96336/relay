import { CanonicalChoirMixExperiment, type CanonicalChoirFrame } from './choir-canonical-mix-experiment.js';
import { ChoirPublisherRegistry } from './choir-publisher-registry.js';
import { ChoirSession, type ChoirSeat } from './choir-session.js';
import type { PcmFrame } from './pcm-frame.js';
import type { ChoirAlignmentDecision } from './choir-calibration-experiment.js';

/**
 * OFFLINE server boundary for real canonical MicTracks. NOT connected to
 * WebSocket/WebTransport. The host adapter MUST derive verifiedParticipantId
 * from the existing private capability and transportId from its live socket;
 * neither value may be accepted from the PCM packet or a claimed user field.
 */
export type TrustedChoirAdmission = {
  verifiedParticipantId: string;
  transportId: string;
  seat: ChoirSeat;
  expectedPrimaryId: string | null;
  nowMs: number;
};

export type ChoirDeadlineRoomOptions = {
  sampleRate: number;
  frameMs: number;
  prebufferMs: number;
  retentionMs: number;
  songEpoch: number;
  backingGeneration: number;
  /** Shared room time origin established by the trusted server clock. */
  roomEpochMs: number;
  /** Additional time allowed for both singers' packets before a frame seals. */
  outputHoldbackMs: number;
  /** Defaults to 8; larger outages require an explicit new room epoch. */
  maxCatchupFrames?: number;
  reconnectGraceMs?: number;
};

export type ChoirDeadlineResult =
  | { state: 'not-due'; frames: [] }
  | { state: 'ready'; frames: CanonicalChoirFrame[] }
  | { state: 'resync-required'; frames: []; reason: 'late-clock' | 'time-regression' };

export type ChoirTrustedAdmissionResult =
  | { ok: true; mediaEpoch: number; idempotent: boolean }
  | { ok: false; reason: 'invalid-clock' | 'rebind-deferred' | 'room-rejected'
      | 'invalid' | 'transport-in-use' | 'seat-rejected' };

/**
 * A bounded proof that authenticated transports, independent MicTracks and
 * fixed room-output deadlines can cooperate without integrating production
 * server handlers or changing N=1 AudioSession.
 *
 * This scheduler intentionally latches on long timer stalls: emitting hundreds
 * of already-expired frames would replay old singing. Restarting requires a
 * fresh room/transport epoch, not silently rewinding an output sample cursor.
 */
export class ChoirDeadlineRoomExperiment {
  private readonly registry: ChoirPublisherRegistry;
  private readonly room: CanonicalChoirMixExperiment;
  private readonly seats: ChoirSession;

  private readonly sampleRate: number;
  private readonly frameMs: number;
  private readonly frameSamples: number;
  private readonly roomEpochMs: number;
  private readonly holdbackMs: number;
  private readonly maxCatchupFrames: number;
  private readonly songEpoch: number;
  private readonly backingGeneration: number;
  private nextFrameIndex = 0;
  private readonly sealedFrames: CanonicalChoirFrame[] = [];
  private lastNowMs = Number.NEGATIVE_INFINITY;
  private invalidated: 'late-clock' | 'time-regression' | null = null;

  constructor(config: ChoirDeadlineRoomOptions) {
    if (!Number.isFinite(config.roomEpochMs)
      || !Number.isFinite(config.outputHoldbackMs)
      || config.outputHoldbackMs < 0 || config.outputHoldbackMs > 5_000
      || !Number.isInteger(config.maxCatchupFrames ?? 8)
      || (config.maxCatchupFrames ?? 8) < 1
      || (config.maxCatchupFrames ?? 8) > 64) {
      throw new RangeError('Invalid trusted Choir deadline schedule');
    }
    this.sampleRate = config.sampleRate;
    this.frameMs = config.frameMs;
    this.frameSamples = Math.round(config.sampleRate * config.frameMs / 1000);
    this.roomEpochMs = config.roomEpochMs;
    this.holdbackMs = config.outputHoldbackMs;
    this.maxCatchupFrames = config.maxCatchupFrames ?? 8;
    this.songEpoch = config.songEpoch;
    this.backingGeneration = config.backingGeneration;
    this.seats = new ChoirSession(2);
    this.registry = new ChoirPublisherRegistry(this.seats, config.reconnectGraceMs ?? 2_000);
    this.room = new CanonicalChoirMixExperiment(config);
  }

  private validNow(nowMs: number): boolean {
    return Number.isFinite(nowMs) && nowMs >= this.roomEpochMs;
  }

  /**
   * Commit every elapsed output deadline BEFORE any source, seat or control
   * mutation at that wall-clock instant. Frames remain in a bounded FIFO
   * until renderDue() takes them. A late arriving Mic cannot sneak into a
   * logically expired frame simply because the output callback was delayed.
   */
  private sealDueNow(nowMs: number): boolean {
    if (this.invalidated !== null) return false;
    if (!this.validNow(nowMs) || nowMs < this.lastNowMs) {
      this.invalidated = 'time-regression';
      this.sealedFrames.length = 0;
      return false;
    }
    this.lastNowMs = nowMs;
    const dueCount = Math.floor(
      (nowMs - this.roomEpochMs - this.holdbackMs) / this.frameMs + 1e-9,
    );
    const backlog = dueCount - this.nextFrameIndex;
    if (backlog <= 0) return true;
    // If the output sink is not draining, queued sealed frames are a replay
    // hazard too; bound total undelivered PCM, not only new timer lateness.
    if (backlog + this.sealedFrames.length > this.maxCatchupFrames) {
      this.invalidated = 'late-clock';
      this.sealedFrames.length = 0;
      return false;
    }
    for (let i = 0; i < backlog; i++) {
      this.sealedFrames.push(this.room.render(this.nextFrameIndex * this.frameSamples));
      this.nextFrameIndex++;
    }
    return true;
  }

  /** Admission is permitted only after a verified server transport handshake. */
  admitTrusted(req: TrustedChoirAdmission): ChoirTrustedAdmissionResult {
    if (!this.sealDueNow(req.nowMs)) {
      return { ok: false, reason: 'invalid-clock' };
    }
    // Until seamless capture-tail retirement is implemented, never replace an
    // already allocated MicTrack with a new media epoch. Failing closed avoids
    // both a stale PCM replay and a hard-cut across capture generations.
    const already = this.room.mediaEpochFor(req.verifiedParticipantId);
    if (already !== null) {
      const bound = this.registry.activePublisherForTransport(req.transportId);
      if (bound?.participantId === req.verifiedParticipantId
        && bound.mediaEpoch === already) {
        return { ok: true, mediaEpoch: already, idempotent: true };
      }
      // New authenticated socket is admitted only after the LAST audible
      // old PCM sample and its output missing-edge have completed. Fresh
      // mediaEpoch and a fresh MicTrack mean no reused capture source index.
      if (!this.room.canRebindDisconnected(req.verifiedParticipantId)) {
        return { ok: false, reason: 'rebind-deferred' };
      }
    }
    const result = this.registry.admit({
      authenticatedParticipantId: req.verifiedParticipantId,
      transportId: req.transportId, seat: req.seat,
      expectedPrimaryId: req.expectedPrimaryId, nowMs: req.nowMs,
    });
    if (!result.ok) return { ok: false, reason: result.reason };
    const nextIdentity = {
      participantId: req.verifiedParticipantId,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
      mediaEpoch: result.mediaEpoch,
    };
    const admitted = already === null
      ? this.room.addSinger(nextIdentity)
      : this.room.replaceDisconnectedSinger(nextIdentity);
    if (!admitted) {
      this.registry.release(req.verifiedParticipantId);
      return { ok: false, reason: 'room-rejected' };
    }
    return { ok: true, mediaEpoch: result.mediaEpoch, idempotent: false };
  }

  /**
   * Only an EXPLICIT control action on the verified transport can Take Mic.
   * A stale compare-and-swap fails; losing A's publisher never self-promotes B.
   * Keeps B's already running media epoch and independent MicTrack intact.
   * This does not transfer song playback authority.
   */
  takePrimaryTrusted(
    transportId: string, expectedPrimaryId: string | null, nowMs: number,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.seat !== 'secondary') return false;
    const before = this.seats.primaryMicId;
    const result = this.seats.claimPrimary(active.participantId, expectedPrimaryId);
    if (!result.ok) return false;
    if (before !== null && before !== active.participantId) {
      const evicted = this.registry.snapshot().find(
        admission => admission.participantId === before,
      );
      if (evicted) {
        this.room.disconnect({
          participantId: before,
          songEpoch: this.songEpoch,
          backingGeneration: this.backingGeneration,
          mediaEpoch: evicted.mediaEpoch,
        });
        this.registry.release(before);
      }
    }
    return true;
  }

  /**
   * Server-only handoff after the separate Content/Sample/Boot experiment
   * validates its capture identity and freshness for the NEW media epoch.
   * A raw client alignment candidate must NEVER invoke this.
   */
  acceptTrustedReboundAlignment(
    transportId: string, mediaEpoch: number,
    decision: ChoirAlignmentDecision, nowMs: number,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch) return false;
    return this.room.acceptReboundAlignment({
      participantId: active.participantId,
      mediaEpoch: active.mediaEpoch,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
    }, decision);
  }

  /**
   * Server-only handoff for a NEW verified Content proof replacing a rebound
   * Sample/Boot estimate. Callers must have checked source identity, revision,
   * and raw acoustic evidence; the room only enforces playback safety.
   * No automatic fallback-to-Content promotion from client observations.
   */
  acceptTrustedLiveContentRecovery(
    transportId: string, mediaEpoch: number, proofRevision: number,
    decision: ChoirAlignmentDecision, nowMs: number,
    takeFrozen: boolean,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch) return false;
    return this.room.recoverContentWithoutJump({
      participantId: active.participantId,
      mediaEpoch: active.mediaEpoch,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
    }, proofRevision, decision, takeFrozen);
  }

  disconnectTransport(transportId: string, nowMs: number): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || !this.registry.disconnect(transportId, nowMs)) return false;
    return this.room.disconnect({
      participantId: active.participantId,
      mediaEpoch: active.mediaEpoch,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
    });
  }

  /**
   * A Mic frame has NO client-advertised singer or media epoch parameter.
   * A fresh transport lookup chooses the exact canonical PCM stream.
   */
  receiveFromTransport(
    transportId: string, frame: PcmFrame, sourceRate: number, nowMs: number,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const publisher = this.registry.activePublisherForTransport(transportId);
    if (!publisher) return false;
    const roomNowSample = Math.floor(
      (nowMs - this.roomEpochMs) * this.sampleRate / 1000,
    );
    if (!Number.isSafeInteger(roomNowSample)) return false;
    return this.room.ingestMic({
      participantId: publisher.participantId,
      mediaEpoch: publisher.mediaEpoch,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
    }, frame, sourceRate, roomNowSample);
  }

  /** Robot/Backing may only be called by the server's trusted media route. */
  receiveTrustedBacking(frame: PcmFrame, sourceRate: number, nowMs: number) {
    if (!this.sealDueNow(nowMs)) return false;
    const roomNowSample = Math.floor(
      (nowMs - this.roomEpochMs) * this.sampleRate / 1000,
    );
    return Number.isSafeInteger(roomNowSample)
      && this.room.ingestBacking(frame, sourceRate, roomNowSample);
  }

  /** Return previously sealed frames, plus any newly due at this clock tick. */
  renderDue(nowMs: number): ChoirDeadlineResult {
    if (!this.sealDueNow(nowMs)) {
      return {
        state: 'resync-required', frames: [],
        reason: this.invalidated ?? 'time-regression',
      };
    }
    if (this.sealedFrames.length === 0) return { state: 'not-due', frames: [] };
    return { state: 'ready', frames: this.sealedFrames.splice(0) };
  }

  /** Read-only diagnostic copies; callers cannot mutate admission or PCM state. */
  snapshot() {
    return {
      seats: this.seats.snapshot(),
      publishers: this.registry.snapshot().map(({ participantId, mediaEpoch, connected }) => ({
        participantId, mediaEpoch, connected,
      })),
    };
  }

  /** Server diagnostic only; never accepts or grants transport credentials. */
  inspectTransport(transportId: string) {
    return this.registry.activePublisherForTransport(transportId);
  }

  /** Evidence-only view: no client credentials or private transport references. */
  get outputSampleCursor() { return this.nextFrameIndex * this.frameSamples; }
}
