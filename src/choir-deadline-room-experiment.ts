import { CanonicalChoirMixExperiment, type CanonicalChoirFrame } from './choir-canonical-mix-experiment.js';
import { ChoirPublisherRegistry } from './choir-publisher-registry.js';
import { ChoirSession, type ChoirSeat } from './choir-session.js';
import type { PcmFrame } from './pcm-frame.js';
import type { ChoirAlignmentDecision } from './choir-alignment-decision.js';
import { analyzeTimingCalibration } from './timing-calibration.js';

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
  /** Trusted playback/video identity; mandatory for the real Content proof route. */
  videoId?: string;
  /** Dedicated Content-only PCM history, independent of short playback rings. */
  contentHistoryMs?: number;
  /** Shared room time origin established by the trusted server clock. */
  roomEpochMs: number;
  /** Additional time allowed for both singers' packets before a frame seals. */
  outputHoldbackMs: number;
  /** Defaults to 8; larger outages require an explicit new room epoch. */
  maxCatchupFrames?: number;
  reconnectGraceMs?: number;
  /** New trusted Room Epoch must allocate disjoint singer Media Epochs. */
  firstMediaEpoch?: number;
  /** First admission in a new trusted room must prove fresh Content. */
  requireInitialContent?: boolean;
};

export type ChoirDeadlineResult =
  | { state: 'not-due'; frames: [] }
  | { state: 'ready'; frames: CanonicalChoirFrame[] }
  | { state: 'resync-required'; frames: []; reason: 'late-clock' | 'time-regression'
      | 'playback-mapping-changed' };

/** Server-private immutable authority captured with the source PCM window.
 * Raw PCM exists only transiently on the main thread before Worker transfer.
 */
export type ChoirWorkerContentSnapshot = {
  readonly participantId: string;
  readonly transportId: string;
  readonly mediaEpoch: number;
  readonly songEpoch: number;
  readonly backingGeneration: number;
  readonly videoId: string;
  readonly mappingEpoch: number;
  readonly captureGeneration: number;
  readonly sourceRate: number;
  readonly startSample: number;
  readonly endSample: number;
  readonly attempt: number;
  readonly preparedAtMs: number;
  readonly mic: Int16Array;
  readonly backing: Int16Array;
};

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
  private readonly videoId: string | null;
  private backingNativeSourceRate: number | null = null;
  private playbackMapping: {
    mappingEpoch: number; videoId: string; robotCaptureGeneration: number;
    playbackRate: number; playing: boolean;
  } | null = null;
  private readonly contentRevisions = new Map<string, number>();
  private readonly contentAttempts = new Map<string, number>();
  private readonly pendingCanonicalContent = new Map<string, {
    participantId: string; transportId: string; mediaEpoch: number;
    songEpoch: number; backingGeneration: number; videoId: string;
    captureGeneration: number; sourceRate: number;
    revision: number; measuredAtMs: number; endSample: number; advanceMs: number;
    workerPreparedAtMs?: number;
    mappingEpoch: number;
  }>();
  private nextFrameIndex = 0;
  private readonly sealedFrames: CanonicalChoirFrame[] = [];
  private lastNowMs = Number.NEGATIVE_INFINITY;
  private invalidated: 'late-clock' | 'time-regression'
    | 'playback-mapping-changed' | null = null;

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
    if (config.videoId !== undefined && !/^[A-Za-z0-9_-]{11}$/.test(config.videoId))
      throw new RangeError('Invalid Choir Content video ID');
    this.videoId = config.videoId ?? null;
    this.seats = new ChoirSession(2);
    this.registry = new ChoirPublisherRegistry(
      this.seats, config.reconnectGraceMs ?? 2_000, config.firstMediaEpoch ?? 1,
    );
    this.room = new CanonicalChoirMixExperiment({
      ...config, contentHistoryMs: this.videoId === null
        ? undefined : config.contentHistoryMs ?? 7_000,
    });
  }

  /** Server-owned frontier, including epochs consumed by failed admissions. */
  get nextUnissuedMediaEpoch() {
    return this.registry.nextUnissuedMediaEpoch;
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
    // An admitted NEW Media Epoch invalidates every pending proof from A/A2.
    this.pendingCanonicalContent.delete(req.verifiedParticipantId);
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

  /**
   * Record a large Content disagreement without mutating live PCM alignment.
   * The singer keeps audible fallback until an explicit disconnect and safe
   * replacement. Transport, Take and evidence verification are server-owned.
   */
  requestTrustedLargeContentReacquisition(
    transportId: string, mediaEpoch: number, proofRevision: number,
    decision: ChoirAlignmentDecision, nowMs: number, takeFrozen: boolean,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch) return false;
    return this.room.stageLargeContentReacquisition({
      participantId: active.participantId,
      mediaEpoch: active.mediaEpoch,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
    }, proofRevision, decision, takeFrozen);
  }

  /**
   * Only after a NEW server Media Epoch and NEW capture generation can an
   * independently verified Content proof enable a re-acquired singer.
   * The host must derive proof identity/revision from its private validator.
   */
  acceptTrustedReacquiredContent(
    transportId: string, mediaEpoch: number,
    proof: { mediaEpoch: number; captureGeneration: number; revision: number },
    decision: ChoirAlignmentDecision, nowMs: number,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch
      || proof.mediaEpoch !== mediaEpoch) return false;
    return this.room.acceptReacquiredContent({
      participantId: active.participantId,
      mediaEpoch: active.mediaEpoch,
      songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration,
    }, proof, decision);
  }

  /**
   * The trusted SongSession adapter uses this when its already-authenticated
   * leader loses freshness, ownership or media-clock authority. There may
   * not be a new valid playback mapping to pass to setTrustedPlaybackMapping.
   * No old acoustic authority or queued room output survives this event.
   */
  invalidateTrustedPlaybackAuthority(nowMs: number): boolean {
    if (this.invalidated !== null || this.playbackMapping === null
      || !this.validNow(nowMs) || nowMs < this.lastNowMs) return false;
    // A lost trusted song clock is an emergency cancellation, not another
    // playable source mutation. Never render stale deadlines just to discard
    // them, and never let an unrelated catchup budget hide the real reason.
    this.lastNowMs = nowMs;
    this.pendingCanonicalContent.clear();
    this.room.invalidateContentEvidenceHistory();
    this.invalidated = 'playback-mapping-changed';
    this.sealedFrames.length = 0;
    return true;
  }

  /**
   * Explicitly trusted Robot-to-YouTube playback transition. The call is only
   * for the server's own Robot controller, NEVER a client PCM/control field.
   * Every pause, seek, video change or Robot source rebuild requires a NEW
   * mappingEpoch; prior acoustic history and pending Content are cleared.
   *
   * The fixed Choir room song/backing epoch must be replaced by a fresh room
   * for a different video or Robot source. It cannot silently change in place.
   */
  setTrustedPlaybackMapping(
    update: {
      mappingEpoch: number; videoId: string;
      songEpoch: number; backingGeneration: number;
      robotCaptureGeneration: number; playbackRate: number; playing: boolean;
    }, nowMs: number,
  ): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    if (this.videoId === null
      || !Number.isSafeInteger(update.mappingEpoch) || update.mappingEpoch < 1
      || !Number.isSafeInteger(update.robotCaptureGeneration)
      || update.robotCaptureGeneration < 0
      || !Number.isFinite(update.playbackRate) || update.playbackRate <= 0
      || typeof update.playing !== 'boolean'
      || (this.playbackMapping && update.mappingEpoch <= this.playbackMapping.mappingEpoch))
      return false;
    const identityChanged = update.videoId !== this.videoId
      || update.songEpoch !== this.songEpoch
      || update.backingGeneration !== this.backingGeneration
      || update.robotCaptureGeneration !== this.backingGeneration;
    // The first playback mapping must match the fixed room epoch and be
    // actively playing. A pause/seek/rate/video/source change after that
    // must RECREATE the room, never keep rendering stale audible Content.
    if (this.playbackMapping === null && (identityChanged || !update.playing))
      return false;
    this.pendingCanonicalContent.clear();
    this.room.invalidateContentEvidenceHistory();
    if (this.playbackMapping !== null) {
      this.invalidated = 'playback-mapping-changed';
      this.sealedFrames.length = 0;
      return !identityChanged;
    }
    this.playbackMapping = {
      mappingEpoch: update.mappingEpoch, videoId: update.videoId,
      robotCaptureGeneration: update.robotCaptureGeneration,
      playbackRate: update.playbackRate, playing: update.playing,
    };
    return true;
  }

  /** Only diagnostics, never grants playback or acoustic authority. */
  get contentBufferSampleCounts() {
    return Object.fromEntries(
      this.registry.snapshot().map(p => [
        p.participantId, this.room.contentHistorySamples(p.participantId),
      ]),
    );
  }


  /**
   * Proof-only Worker preparation. The server picks a fully positioned window
   * ending within one second of the trusted room clock; clients cannot choose
   * sample positions or supply candidate PCM. A snapshot belongs to exactly
   * one transport / Media Epoch / capture / mapping and analysis attempt.
   *
   * At most 50 bounded native-room-frame window checks are performed. Only
   * ONE complete window is copied (2 x six seconds of Int16 PCM).
   */
  prepareTrustedWorkerContent(
    transportId: string, mediaEpoch: number, nowMs: number,
  ): ChoirWorkerContentSnapshot | null {
    if (!this.sealDueNow(nowMs) || this.videoId === null
      || !this.playbackMapping?.playing) return null;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch) return null;
    const id = {
      participantId: active.participantId, mediaEpoch,
      songEpoch: this.songEpoch, backingGeneration: this.backingGeneration,
    };
    const state = this.room.contentProofState(id);
    if (!state || state.captureGeneration === null || state.sourceRate === null
      || !state.awaitingCalibration) return null;
    const count = 6 * this.sampleRate;
    const nowSample = Math.floor((nowMs - this.roomEpochMs) * this.sampleRate / 1000);
    const alignedEnd = Math.floor(nowSample / this.frameSamples) * this.frameSamples;
    const step = this.frameSamples; // room frame boundary, typically 20ms
    const lastOffset = Math.round(this.sampleRate * .95);
    for (let offset = 0; offset <= lastOffset; offset += step) {
      const endSample = alignedEnd - offset;
      const startSample = endSample - count;
      if (startSample < 0) continue;
      const clip = this.room.readTrustedContentWindow(
        id, state.captureGeneration, startSample,
      );
      if (!clip) continue;
      const attempt = (this.contentAttempts.get(active.participantId) ?? 0) + 1;
      this.contentAttempts.set(active.participantId, attempt);
      this.pendingCanonicalContent.delete(active.participantId);
      return {
        participantId: active.participantId, transportId, mediaEpoch,
        songEpoch: this.songEpoch, backingGeneration: this.backingGeneration,
        videoId: this.videoId, mappingEpoch: this.playbackMapping.mappingEpoch,
        captureGeneration: state.captureGeneration, sourceRate: state.sourceRate,
        startSample, endSample, attempt, preparedAtMs: nowMs,
        mic: clip.mic, backing: clip.backing,
      };
    }
    return null;
  }

  /**
   * Accept a result from the server-owned analysis worker ONLY after all
   * source authority and clock facts match the immutable PCM snapshot.
   * This does not commit sound; commitTrustedCanonicalContent owns the final
   * one-time eligibility check and applies the stored result.
   */
  stageTrustedWorkerContent(
    proof: ChoirWorkerContentSnapshot,
    result: { micLagMs: number; confidence: number }, nowMs: number,
  ): boolean {
    if (!this.sealDueNow(nowMs)
      || !this.playbackMapping?.playing
      || !Number.isFinite(result.micLagMs)
      || !Number.isFinite(result.confidence)
      || result.confidence <= 0 || result.confidence > 1
      || Math.abs(result.micLagMs) > 2_800
      || this.videoId !== proof.videoId
      || this.songEpoch !== proof.songEpoch
      || this.backingGeneration !== proof.backingGeneration
      || this.playbackMapping.mappingEpoch !== proof.mappingEpoch
      || this.contentAttempts.get(proof.participantId) !== proof.attempt
      || nowMs < proof.preparedAtMs
      || nowMs - proof.preparedAtMs > 2_500
      // The 1s source-window freshness gate applies at snapshot preparation;
      // the separate 2.5s lease above bounds asynchronous analysis.
      || !Number.isSafeInteger(proof.endSample)
      || Math.abs(Math.floor((proof.preparedAtMs - this.roomEpochMs) * this.sampleRate / 1000)
        - proof.endSample) > this.sampleRate) return false;
    const active = this.registry.activePublisherForTransport(proof.transportId);
    if (!active || active.participantId !== proof.participantId
      || active.mediaEpoch !== proof.mediaEpoch) return false;
    const id = {
      participantId: active.participantId, mediaEpoch: proof.mediaEpoch,
      songEpoch: this.songEpoch, backingGeneration: this.backingGeneration,
    };
    const state = this.room.contentProofState(id);
    if (!state || !state.awaitingCalibration
      || state.captureGeneration !== proof.captureGeneration
      || state.sourceRate !== proof.sourceRate) return false;
    const revision = (this.contentRevisions.get(proof.participantId) ?? 0) + 1;
    this.contentRevisions.set(proof.participantId, revision);
    // One attempt is one-shot, including after a rejected commit.
    this.contentAttempts.delete(proof.participantId);
    this.pendingCanonicalContent.set(proof.participantId, {
      participantId: proof.participantId, transportId: proof.transportId,
      mediaEpoch: proof.mediaEpoch, songEpoch: this.songEpoch,
      backingGeneration: this.backingGeneration, videoId: this.videoId,
      captureGeneration: proof.captureGeneration, sourceRate: proof.sourceRate,
      revision, measuredAtMs: proof.preparedAtMs, endSample: proof.endSample,
      workerPreparedAtMs: proof.preparedAtMs,
      advanceMs: result.micLagMs, mappingEpoch: proof.mappingEpoch,
    });
    return true;
  }

  /**
   * Actually analyze six seconds of Mic + Robot backing already ingested in
   * their CANONICAL room PCM timelines. This never accepts supplied samples,
   * client-claimed lag, confidence, proof token or generation. A caller may
   * select a window only; gaps/frontier/unheadered/stale backing are rejected.
   * This is an offline server-side experiment, not a production socket API.
   */
  analyzeTrustedCanonicalContent(
    transportId: string, mediaEpoch: number,
    startSample: number, nowMs: number,
  ): { status: 'candidate'; revision: number; lagMs: number; confidence: number }
    | { status: 'rejected'; reason: string } {
    if (!this.sealDueNow(nowMs)) return { status: 'rejected', reason: 'invalid-clock' };
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch || this.videoId === null)
      return { status: 'rejected', reason: 'untrusted-transport-or-song' };
    if (!this.playbackMapping?.playing)
      return { status: 'rejected', reason: 'robot-mapping-not-playing' };
    const participantId = active.participantId;
    this.pendingCanonicalContent.delete(participantId);
    // Six seconds held in retention are not necessarily six seconds of
    // CURRENT song playback. A caller cannot relabel an old PCM window by
    // running the analyzer much later and using a fresh wall-clock timestamp.
    const nowSample = Math.floor((nowMs - this.roomEpochMs) * this.sampleRate / 1000);
    const endSample = startSample + 6 * this.sampleRate;
    const maximumWindowSkew = this.sampleRate; // 1s, conservative experiment guard
    if (!Number.isSafeInteger(nowSample) || !Number.isSafeInteger(endSample)
      || Math.abs(nowSample - endSample) > maximumWindowSkew)
      return { status: 'rejected', reason: 'stale-content-window' };
    const id = {
      participantId, mediaEpoch,
      songEpoch: this.songEpoch, backingGeneration: this.backingGeneration,
    };
    const state = this.room.contentProofState(id);
    if (!state || state.captureGeneration === null || state.sourceRate === null)
      return { status: 'rejected', reason: 'no-current-capture' };
    const clip = this.room.readTrustedContentWindow(id, state.captureGeneration, startSample);
    if (!clip) return { status: 'rejected', reason: 'incomplete-or-stale-pcm-window' };
    // Analyzer runs on room-rate PCM only. The decision is retained privately:
    // no mutation to the returned diagnostics can change subsequent authority.
    try {
      const result = analyzeTimingCalibration(clip.mic, clip.backing, this.sampleRate);
      if (!Number.isFinite(result.micLagMs)
        || !Number.isFinite(result.confidence)
        || result.confidence <= 0 || result.confidence > 1
        || Math.abs(result.micLagMs) > 2_800) {
        return { status: 'rejected', reason: 'invalid-content-result' };
      }
      const revision = (this.contentRevisions.get(participantId) ?? 0) + 1;
      this.contentRevisions.set(participantId, revision);
      this.pendingCanonicalContent.set(participantId, {
        participantId, transportId, mediaEpoch,
        songEpoch: this.songEpoch, backingGeneration: this.backingGeneration,
        videoId: this.videoId, captureGeneration: state.captureGeneration,
        sourceRate: state.sourceRate, revision, measuredAtMs: nowMs,
        endSample, advanceMs: result.micLagMs,
        mappingEpoch: this.playbackMapping.mappingEpoch,
      });
      return { status: 'candidate', revision, lagMs: result.micLagMs,
        confidence: result.confidence };
    } catch (error) {
      return { status: 'rejected',
        reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Consume the *stored* analyzer result exactly once; no lag, revision or
   * proof material can be submitted as a method argument. Source identity,
   * same Media Epoch, native generation and strict evidence age are rechecked.
   *
   * The trusted host is responsible for Take state; a frozen Take is denied.
   */
  commitTrustedCanonicalContent(
    transportId: string, mediaEpoch: number, nowMs: number, takeFrozen: boolean,
  ): 'applied' | 'staged' | 'rejected' {
    if (!this.sealDueNow(nowMs)) return 'rejected';
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || active.mediaEpoch !== mediaEpoch || takeFrozen
      || !this.playbackMapping?.playing) return 'rejected';
    const pending = this.pendingCanonicalContent.get(active.participantId);
    if (!pending) return 'rejected';
    this.pendingCanonicalContent.delete(active.participantId);
    if (pending.transportId !== transportId || pending.mediaEpoch !== mediaEpoch
      || pending.participantId !== active.participantId
      || pending.songEpoch !== this.songEpoch
      || pending.backingGeneration !== this.backingGeneration
      || pending.videoId !== this.videoId
      || pending.mappingEpoch !== this.playbackMapping.mappingEpoch
      || !Number.isFinite(nowMs) || nowMs < pending.measuredAtMs
      || nowMs - pending.measuredAtMs > 20_000
      // Worker snapshots must be fresh when submitted, then finish inside
      // the bounded analysis lease. Counting analysis time against the source
      // window's 1s ingest skew would reject valid >1s FFT jobs on slower hosts.
      // Synchronous candidates retain their original live-window freshness.
      || (pending.workerPreparedAtMs !== undefined
        && nowMs - pending.workerPreparedAtMs > 2_500)
      || Math.abs(Math.floor(((pending.workerPreparedAtMs ?? nowMs)
        - this.roomEpochMs) * this.sampleRate / 1000)
        - pending.endSample) > this.sampleRate) return 'rejected';
    const id = {
      participantId: active.participantId, mediaEpoch,
      songEpoch: this.songEpoch, backingGeneration: this.backingGeneration,
    };
    const state = this.room.contentProofState(id);
    if (!state || state.captureGeneration !== pending.captureGeneration
      || state.sourceRate !== pending.sourceRate) return 'rejected';
    const decision: ChoirAlignmentDecision = {
      source: 'content', advanceMs: pending.advanceMs,
      sampleResidualMs: null, bootResidualMs: null,
      sampleCandidateMs: null, bootCandidateMs: null,
    };
    if (state.requiresFreshContent) {
      return this.room.acceptReacquiredContent(id, {
        mediaEpoch, captureGeneration: pending.captureGeneration,
        revision: pending.revision,
      }, decision) ? 'applied' : 'rejected';
    }
    if (state.awaitingCalibration) {
      return this.room.acceptReboundAlignment(id, decision) ? 'applied' : 'rejected';
    }
    if (state.authoritySource === 'sample-song-estimate'
      || state.authoritySource === 'boot-probe-estimate') {
      if (this.room.recoverContentWithoutJump(id, pending.revision, decision, false))
        return 'applied';
      if (this.room.stageLargeContentReacquisition(id, pending.revision, decision, false))
        return 'staged';
    }
    return 'rejected';
  }

  disconnectTransport(transportId: string, nowMs: number): boolean {
    if (!this.sealDueNow(nowMs)) return false;
    const active = this.registry.activePublisherForTransport(transportId);
    if (!active || !this.registry.disconnect(transportId, nowMs)) return false;
    this.pendingCanonicalContent.delete(active.participantId);
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
    if ((this.videoId !== null && !this.playbackMapping?.playing)
      || !Number.isInteger(sourceRate) || sourceRate < 8_000 || sourceRate > 192_000)
      return false;
    // Robot replacement or a source-rate clock rebuild invalidates more than
    // Content evidence: an already audible song may no longer share the same
    // media-time mapping. Fail closed on the entire offline room rather than
    // continuing under an old alignment with newly labelled PCM.
    if (frame.generation !== this.backingGeneration
      || (this.backingNativeSourceRate !== null
        && sourceRate !== this.backingNativeSourceRate)) {
      this.pendingCanonicalContent.clear();
      this.room.invalidateContentEvidenceHistory();
      this.invalidated = 'playback-mapping-changed';
      this.sealedFrames.length = 0;
      return false;
    }
    const roomNowSample = Math.floor(
      (nowMs - this.roomEpochMs) * this.sampleRate / 1000,
    );
    const accepted = Number.isSafeInteger(roomNowSample)
      && this.room.ingestBacking(frame, sourceRate, roomNowSample);
    if (accepted && this.backingNativeSourceRate === null)
      this.backingNativeSourceRate = sourceRate;
    return accepted;
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
