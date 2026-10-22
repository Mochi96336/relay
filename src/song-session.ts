import { performance } from 'node:perf_hooks';

import { YouTubeTimelineTracker } from './youtube-timeline.js';
import { playbackTargetState, playbackStartPosition } from '../shared/song-playback-target.js';

const LEADER_STALE_AFTER_MS = 1_500;
const HANDOFF_TIME_TOLERANCE_SECONDS = 1.5;
/**
 * How long a target that has never acknowledged preparation may hold a handoff.
 */
const HANDOFF_PREPARE_TIMEOUT_MS = 20_000;
/**
 * Hard ceiling for the whole handoff, including retries after an acknowledged
 * ready state. A target may need a short retry or a user gesture, but it must
 * never freeze the room indefinitely once it has said "ready" once.
 */
const HANDOFF_TOTAL_TIMEOUT_MS = 30_000;
/**
 * A commit is only a short proof window. If the target does not produce proof,
 * the server cancels the handoff; a healthy client can explicitly defer before
 * this deadline and retry, but a stuck client cannot make the server roll back
 * silently into an immortal preparing state.
 */
const HANDOFF_COMMIT_TIMEOUT_MS = 5_000;
const HOLDOVER_TIME_TOLERANCE_SECONDS = 0.9;
/** YT.PlayerState.BUFFERING: transport progress, not playback proof. */
const BUFFERING_STATE = 3;
const PLAYING_STATE = 1;
const CUED_STATE = 5;

export type PlaybackIdentity = {
  participantId: string;
  transportId: string;
  generation: number;
};

export type SongTelemetryResult = {
  accepted: boolean;
  reason?:
    | 'invalid-identity'
    | 'invalid-telemetry'
    | 'mic-owner-required'
    | 'leader-busy'
    | 'handoff-not-target'
    | 'handoff-not-ready'
    | 'handoff-song-mismatch'
    | 'handoff-holdover-semantic-change';
  leaderChanged: boolean;
  handoffCompleted?: boolean;
  handoffId?: string;
  previousLeader?: PlaybackIdentity | null;
};

export type SongHandoffPlan = {
  handoffId: string;
  revision: number;
  target: PlaybackIdentity;
  videoId: string;
  state: 1 | 5;
  serverTime: number;
  playbackRate: number;
};

type Leader = PlaybackIdentity & {
  connected: boolean;
  lastTelemetryAtMs: number;
};

type Handoff = {
  id: string;
  target: PlaybackIdentity;
  state: 'preparing' | 'committing';
  startedAtMs: number;
  commitStartedAtMs: number | null;
  readyAcknowledged: boolean;
  announcedState: 1 | 5;
  /**
   * Candidate-only clock evidence. BUFFERING reports may advance this tracker
   * so a real PLAYING proof can be judged against the target's own recent
   * reports without overwriting the authoritative room timeline or leader.
   */
  targetTimeline: YouTubeTimelineTracker;
};

/** Why a Mic owner's playback tab was not asked to take over the song. */
export type HandoffRefusal =
  | 'invalid-target'
  | 'target-not-mic-owner'
  | 'no-leader'
  | 'no-telemetry'
  | 'target-is-leader';

/** Why a handoff in flight was abandoned. */
export type HandoffSweepReason =
  | 'target-gone'
  | 'total-timeout'
  | 'commit-timeout'
  | 'prepare-timeout';

type FailedHandoffHoldover = {
  leader: PlaybackIdentity;
  micOwnerId: string;
};

export function normalizePlaybackTransportId(value: unknown) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(id) ? id : null;
}

export function normalizePlaybackGeneration(value: unknown) {
  const generation = Number(value);
  return Number.isSafeInteger(generation) && generation >= 0
    ? generation
    : null;
}

/**
 * Room-owned song state and the authority boundary in front of media-clock
 * measurement.
 *
 * YouTubeTimelineTracker deliberately remains ignorant of people and sockets:
 * it measures one accepted media clock. SongSession decides which playback
 * transport is allowed to feed that clock and, when microphone ownership moves,
 * keeps the old clock alive until the new owner's exact playback transport is
 * ready to control a dormant song or actually rendering a moving song.
 *
 * The playback leader remains an implementation detail, not a visible DJ role.
 * A prepared handoff is also intentionally not triggered by presence alone:
 * callers must begin it from an explicit product action such as microphone
 * acquisition. The target is prepared first, then committed, and only real
 * target playback proof completes the handoff.
 */
export class SongSession {
  private readonly timeline = new YouTubeTimelineTracker();
  private leader: Leader | null = null;
  private handoff: Handoff | null = null;
  // A dormant controller is cued, not a second media clock. Keep the room's
  // semantic state/position until an authorized playback action starts media.
  private parked: { identity: PlaybackIdentity; mediaPosition: number } | null = null;
  private failedHandoffHoldover: FailedHandoffHoldover | null = null;
  private handoffSequence = 0;
  private revisionValue = 0;

  get revision() {
    return this.revisionValue;
  }

  get hasTelemetry() {
    return this.timeline.hasTelemetry;
  }

  beginHandoff(
    targetInput: PlaybackIdentity,
    micOwnerId: string | null,
    nowMs = performance.now(),
  ): SongHandoffPlan | null {
    if (this.handoffRefusal(targetInput, micOwnerId)) return null;
    const target = this.normalizeIdentity(targetInput)!;

    if (this.handoff && this.sameIdentity(this.handoff.target, target)) {
      return this.handoffPlan(nowMs);
    }

    this.failedHandoffHoldover = null;
    this.handoffSequence += 1;
    this.handoff = this.newHandoff(`song-handoff-${this.handoffSequence}`, target, nowMs);
    this.bump();
    return this.handoffPlan(nowMs);
  }

  /** Why beginHandoff would not start for this target, or null if it would. */
  handoffRefusal(targetInput: PlaybackIdentity, micOwnerId: string | null): HandoffRefusal | null {
    const target = this.normalizeIdentity(targetInput);
    if (!target) return 'invalid-target';
    if (micOwnerId === null || target.participantId !== micOwnerId) return 'target-not-mic-owner';
    if (!this.leader) return 'no-leader';
    if (!this.hasTelemetry) return 'no-telemetry';
    if (this.sameIdentity(this.leader, target)) return 'target-is-leader';
    return null;
  }

  handoffPlanForTarget(identityInput: PlaybackIdentity, nowMs = performance.now()) {
    const identity = this.normalizeIdentity(identityInput);
    if (!identity || !this.handoff) return null;
    if (this.sameIdentity(this.handoff.target, identity)) return this.handoffPlan(nowMs);

    // A page reload keeps the logical playback transport but creates a newer
    // incarnation. Move the target identity forward, but preserve the original
    // handoff birth time: repeated reloads are recovery attempts inside one
    // bounded handoff, not a way to mint a fresh 30 s authority freeze forever.
    if (
      this.handoff.target.participantId === identity.participantId
      && this.handoff.target.transportId === identity.transportId
      && identity.generation > this.handoff.target.generation
    ) {
      const startedAtMs = this.handoff.startedAtMs;
      this.handoffSequence += 1;
      this.handoff = this.newHandoff(
        `song-handoff-${this.handoffSequence}`,
        identity,
        nowMs,
        startedAtMs,
      );
      this.bump();
      return this.handoffPlan(nowMs);
    }

    return null;
  }

  markHandoffReady(
    identityInput: PlaybackIdentity,
    handoffId: unknown,
    micOwnerId: string | null,
    nowMs = performance.now(),
  ): SongHandoffPlan | null {
    const identity = this.normalizeIdentity(identityInput);
    if (
      !identity
      || !this.handoff
      || handoffId !== this.handoff.id
      || !this.sameIdentity(this.handoff.target, identity)
      || micOwnerId !== identity.participantId
    ) return null;

    this.handoff.readyAcknowledged = true;
    if (this.handoff.state !== 'committing') {
      this.handoff.state = 'committing';
      this.handoff.commitStartedAtMs = nowMs;
      this.bump();
    }
    const plan = this.handoffPlan(nowMs);
    if (plan) this.handoff.announcedState = plan.state;
    return plan;
  }

  /** Refresh the physical target when the song naturally finishes in flight. */
  refreshHandoff(nowMs = performance.now()) {
    if (!this.handoff) return null;
    const plan = this.handoffPlan(nowMs);
    if (!plan || plan.state === this.handoff.announcedState) return null;
    this.handoff.announcedState = plan.state;
    this.handoff.targetTimeline = new YouTubeTimelineTracker();
    return { phase: this.handoff.state, plan };
  }

  deferHandoff(identityInput: PlaybackIdentity, handoffId: unknown) {
    const identity = this.normalizeIdentity(identityInput);
    if (
      !identity
      || !this.handoff
      || handoffId !== this.handoff.id
      || !this.sameIdentity(this.handoff.target, identity)
    ) return false;

    if (this.handoff.state === 'preparing') return false;
    this.handoff.state = 'preparing';
    this.handoff.commitStartedAtMs = null;
    this.handoff.targetTimeline = new YouTubeTimelineTracker();
    this.bump();
    return true;
  }

  cancelHandoff() {
    if (!this.handoff && !this.failedHandoffHoldover) return false;
    this.handoff = null;
    this.failedHandoffHoldover = null;
    this.bump();
    return true;
  }

  /**
   * A failed-handoff holdover belongs to exactly one Mic ownership epoch.
   *
   * Transport expiry deliberately does not cancel a live prepared handoff, so
   * ownership cleanup needs a narrower operation: retire only historical
   * holdover authority while leaving the still-recoverable handoff intact.
   */
  retireFailedHandoffHoldover() {
    if (!this.failedHandoffHoldover) return false;
    this.failedHandoffHoldover = null;
    return true;
  }

  /** The transport a live handoff is waiting for, so callers can check it still exists. */
  handoffTarget(): PlaybackIdentity | null {
    return this.handoff ? { ...this.handoff.target } : null;
  }

  /** The live handoff's id, for the journal. */
  handoffId(): string | null {
    return this.handoff?.id ?? null;
  }

  /**
   * Abandons a handoff whose target is never going to answer.
   *
   * A client that detects an autoplay/apply failure can explicitly defer back
   * to preparation and retry inside the total deadline. The server watchdog is
   * different: if a live client simply stops producing commit proof, the
   * timeout cancels the handoff so the existing server caller can notify the
   * target and broadcast the authoritative idle state. There is deliberately no
   * silent `committing -> preparing` transition here.
   */
  sweepHandoff(
    targetPresent: boolean,
    nowMs = performance.now(),
    micOwnerId: string | null = this.handoff?.target.participantId ?? null,
  ) {
    if (!this.handoffSweepReason(targetPresent, nowMs)) return false;
    return this.cancelFailedHandoff(micOwnerId);
  }

  /** Why sweepHandoff would abandon the live handoff now, or null if it would wait. */
  handoffSweepReason(targetPresent: boolean, nowMs = performance.now()): HandoffSweepReason | null {
    if (!this.handoff) return null;
    if (!targetPresent) return 'target-gone';
    if (nowMs - this.handoff.startedAtMs > HANDOFF_TOTAL_TIMEOUT_MS) return 'total-timeout';
    if (
      this.handoff.state === 'committing'
      && this.handoff.commitStartedAtMs !== null
      && nowMs - this.handoff.commitStartedAtMs > HANDOFF_COMMIT_TIMEOUT_MS
    ) return 'commit-timeout';
    if (
      !this.handoff.readyAcknowledged
      && nowMs - this.handoff.startedAtMs > HANDOFF_PREPARE_TIMEOUT_MS
    ) return 'prepare-timeout';
    return null;
  }

  update(
    payload: Record<string, unknown>,
    identityInput: PlaybackIdentity,
    micOwnerId: string | null,
    nowMs = performance.now(),
    { activatePlayback = false }: { activatePlayback?: boolean } = {},
  ): SongTelemetryResult {
    const identity = this.normalizeIdentity(identityInput);
    if (!identity) {
      return { accepted: false, reason: 'invalid-identity', leaderChanged: false };
    }

    if (!Number.isFinite(Number(payload.currentTime)) || Number(payload.currentTime) < 0) {
      return { accepted: false, reason: 'invalid-telemetry', leaderChanged: false };
    }
    const projectedPayload = activatePlayback ? payload : this.projectTelemetry(payload, identity, nowMs);
    const authority = this.canWrite(projectedPayload, identity, micOwnerId, nowMs);
    if (!authority.ok) {
      return { accepted: false, reason: authority.reason, leaderChanged: false };
    }

    const targetDuringCommit = Boolean(
      this.handoff
      && this.handoff.state === 'committing'
      && this.sameIdentity(this.handoff.target, identity),
    );

    // BUFFERING from the target is useful evidence that its media pipeline is
    // alive, but it is not proof that the singer can actually hear/see the new
    // playback. Keep that evidence on a candidate-only tracker. This preserves
    // the old leader and authoritative room clock while still giving later
    // PLAYING telemetry a recent target-local reference after a real rebuffer.
    if (targetDuringCommit && !this.targetTelemetryCompletes(payload, nowMs)) {
      if (!this.handoff!.targetTimeline.update(payload, nowMs)) {
        return { accepted: false, reason: 'invalid-telemetry', leaderChanged: false };
      }
      return { accepted: true, leaderChanged: false };
    }

    // A cued dormant target proves that its controls are ready, not that a
    // stopped song started playing. Promotion preserves the authoritative room.
    const before = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const dormantContinuation = this.leader
      && this.leader.participantId === identity.participantId
      && this.leader.transportId === identity.transportId
      && identity.generation > this.leader.generation
      && payload.videoId === before.videoId && Number(payload.state) === CUED_STATE;
    const dormantPromotion = !activatePlayback && (targetDuringCommit || dormantContinuation)
      && playbackTargetState(Number(before.state)) === CUED_STATE;
    const roomPayload = dormantPromotion ? {
      ...payload, state: before.state, currentTime: before.serverTime,
      duration: before.duration, playbackRate: before.playbackRate, timelineDeltaSeconds: 0,
    } : projectedPayload;
    if (!this.timeline.update(roomPayload, nowMs)) {
      return { accepted: false, reason: 'invalid-telemetry', leaderChanged: false };
    }
    if (dormantPromotion) {
      this.parked = { identity: { ...identity }, mediaPosition: Number(payload.currentTime) };
    } else if (activatePlayback || Number(payload.state) === PLAYING_STATE
        || this.parked && !this.sameIdentity(this.parked.identity, identity)) {
      this.parked = null;
    }

    const completingHandoff = targetDuringCommit;
    const completedHandoffId = completingHandoff ? this.handoff!.id : undefined;
    const previousLeader = completingHandoff ? this.leaderIdentity() : undefined;

    const leaderChanged = !this.sameIdentity(this.leader, identity);
    if (leaderChanged) {
      this.leader = {
        ...identity,
        connected: true,
        lastTelemetryAtMs: nowMs,
      };
      this.failedHandoffHoldover = null;
      if (completingHandoff) this.handoff = null;
      this.bump();
    } else if (this.leader) {
      this.leader.connected = true;
      this.leader.lastTelemetryAtMs = nowMs;
      if (completingHandoff) {
        this.handoff = null;
        this.failedHandoffHoldover = null;
        this.bump();
      }
    }

    const after = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    if (!leaderChanged && !completingHandoff && this.semanticTimelineChanged(before, after)) this.bump();

    return {
      accepted: true,
      leaderChanged,
      ...(completingHandoff ? {
        handoffCompleted: true,
        handoffId: completedHandoffId,
        previousLeader: previousLeader ?? null,
      } : {}),
    };
  }

  /** Project a dormant iframe's setup readings without inventing room input. */
  projectTelemetry(payload: Record<string, unknown>, identity: PlaybackIdentity, nowMs = performance.now()) {
    if (!this.parked || !this.sameIdentity(this.parked.identity, identity)) return payload;
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const state = Number(payload.state);
    const time = Number(payload.currentTime);
    if (payload.videoId !== room.videoId || !(state === CUED_STATE
        || state === 2 && Number.isFinite(time) && Math.abs(time - this.parked.mediaPosition) <= 0.1)) return payload;
    return { ...payload, state: room.state, currentTime: room.serverTime,
      duration: room.duration, timelineDeltaSeconds: 0 };
  }

  detach(identityInput: PlaybackIdentity) {
    const identity = this.normalizeIdentity(identityInput);
    if (!identity || !this.leader || !this.sameIdentity(this.leader, identity)) return false;
    if (!this.leader.connected) return false;
    this.leader.connected = false;
    this.bump();
    return true;
  }

  statusPayload(nowMs = performance.now()) {
    const timeline = this.timeline.statusPayload(nowMs);
    const leaderFresh = this.leaderAuthorityFresh(nowMs, timeline);

    return {
      ...timeline,
      revision: this.revisionValue,
      playbackLeaderParticipantId: this.leader?.participantId ?? null,
      playbackTransportId: this.leader?.transportId ?? null,
      playbackGeneration: this.leader?.generation ?? null,
      leaderConnected: this.leader?.connected ?? false,
      leaderFresh,
      playbackParked: this.parked !== null,
      handoffState: this.handoff?.state ?? 'idle',
      handoffId: this.handoff?.id ?? null,
      handoffTargetParticipantId: this.handoff?.target.participantId ?? null,
      handoffTargetPlaybackTransportId: this.handoff?.target.transportId ?? null,
      handoffTargetPlaybackGeneration: this.handoff?.target.generation ?? null,
    };
  }

  roomStatusPayload(nowMs = performance.now()) {
    const timeline = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const hasSong = typeof timeline.videoId === 'string';

    return {
      type: 'room-song-status',
      revision: this.revisionValue,
      connected: Boolean(timeline.connected),
      videoId: hasSong ? timeline.videoId ?? null : null,
      state: hasSong ? timeline.state ?? null : null,
      serverTime: hasSong ? timeline.serverTime ?? null : null,
      duration: hasSong ? timeline.duration ?? null : null,
      playbackRate: hasSong ? timeline.playbackRate ?? null : null,
      handoffState: this.handoff?.state ?? 'idle',
      handoffTargetParticipantId: this.handoff?.target.participantId ?? null,
    };
  }

  private canWrite(
    payload: Record<string, unknown>,
    identity: PlaybackIdentity,
    micOwnerId: string | null,
    nowMs: number,
  ): {
    ok: true;
  } | {
    ok: false;
    reason:
      | 'mic-owner-required'
      | 'leader-busy'
      | 'handoff-not-target'
      | 'handoff-not-ready'
      | 'handoff-song-mismatch'
      | 'handoff-holdover-semantic-change';
  } {
    if (this.handoff && this.leader && this.sameIdentity(this.leader, identity)) {
      return this.safeHoldoverTelemetry(payload, nowMs)
        ? { ok: true }
        : { ok: false, reason: 'handoff-holdover-semantic-change' };
    }

    if (this.handoff && this.sameIdentity(this.handoff.target, identity)) {
      if (micOwnerId !== identity.participantId) {
        return { ok: false, reason: 'mic-owner-required' };
      }
      if (this.handoff.state !== 'committing') {
        return { ok: false, reason: 'handoff-not-ready' };
      }
      return this.safeTargetTelemetry(payload, nowMs)
        ? { ok: true }
        : { ok: false, reason: 'handoff-song-mismatch' };
    }

    // Once a handoff exists, the old leader and the exact prepared target are
    // the only transports allowed to touch the room clock. In particular, a
    // second tab owned by the new Mic holder must not fall through to the 0A
    // rule that otherwise lets a Mic owner supersede a previous participant.
    if (this.handoff) {
      return { ok: false, reason: 'handoff-not-target' };
    }

    // Only a handoff that failed after Mic ownership moved earns the old media
    // leader a narrow same-song holdover exception. A plain Mic ownership
    // change with no failed playback transfer must keep the original 0A rule:
    // the old participant is refused with `mic-owner-required`.
    if (
      this.failedHandoffHoldover
      && micOwnerId === this.failedHandoffHoldover.micOwnerId
      && this.sameIdentity(this.failedHandoffHoldover.leader, identity)
    ) {
      return this.safeHoldoverTelemetry(payload, nowMs)
        ? { ok: true }
        : { ok: false, reason: 'handoff-holdover-semantic-change' };
    }

    if (micOwnerId !== null && identity.participantId !== micOwnerId) {
      return { ok: false, reason: 'mic-owner-required' };
    }

    if (!this.leader) return { ok: true };
    if (this.sameIdentity(this.leader, identity)) return { ok: true };

    if (micOwnerId !== null && this.leader.participantId !== micOwnerId) {
      return { ok: true };
    }

    if (!this.leader.connected || !this.leaderAuthorityFresh(nowMs)) return { ok: true };

    // A page reload keeps its transport identity but increments generation.
    // That may replace the previous incarnation immediately. A second live tab
    // has another transport ID and therefore cannot create a last-writer-wins
    // fight with the healthy leader.
    if (
      this.leader.participantId === identity.participantId
      && this.leader.transportId === identity.transportId
      && identity.generation > this.leader.generation
    ) {
      return { ok: true };
    }

    return { ok: false, reason: 'leader-busy' };
  }

  /**
   * How far a report may sit from where this player's own last accepted report
   * would be by now.
   *
   * This is intentionally used for continuity evidence, not as the final room
   * authority gate. A buffering target may remain self-consistent while falling
   * seconds behind the old leader, so final proof also has to be near the live
   * authoritative room clock before promotion.
   */
  private withinOwnReport(
    room: Record<string, unknown>,
    payload: Record<string, unknown>,
    toleranceSeconds: number,
  ) {
    const reportedTime = Number(room.youtubeTime);
    const incomingTime = Number(payload.currentTime);
    if (!Number.isFinite(reportedTime) || !Number.isFinite(incomingTime)) return false;

    const elapsedSeconds = Math.max(0, Number(room.ageMs) || 0) / 1000;
    const delta = incomingTime - reportedTime;
    return delta <= toleranceSeconds && delta >= -(elapsedSeconds + toleranceSeconds);
  }

  private nearAuthoritativeRoom(
    authoritativeTime: number,
    payload: Record<string, unknown>,
    toleranceSeconds: number,
  ) {
    const incomingTime = Number(payload.currentTime);
    if (!Number.isFinite(authoritativeTime) || !Number.isFinite(incomingTime)) return false;
    return Math.abs(incomingTime - authoritativeTime) <= toleranceSeconds;
  }

  private safeHoldoverTelemetry(payload: Record<string, unknown>, nowMs: number) {
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const roomRate = Number(room.playbackRate);
    const incomingRate = Number(payload.playbackRate ?? 1);
    // Buffering is not a decision the singer made, so it is not a semantic
    // change. Demanding the exact room state meant the outgoing leader lost
    // its own holdover the moment its network hiccuped.
    const roomState = Number(room.state);
    const incomingState = Number(payload.state);
    const moving = [PLAYING_STATE, BUFFERING_STATE].includes(roomState);
    const duration = Number(room.duration);
    const naturalEnd = moving && incomingState === 0 && duration > 0
      && Number(payload.currentTime) >= duration - HOLDOVER_TIME_TOLERANCE_SECONDS;
    const stateHeld = incomingState === roomState
      || moving && [PLAYING_STATE, BUFFERING_STATE].includes(incomingState)
      || naturalEnd;

    return typeof room.videoId === 'string'
      && payload.videoId === room.videoId
      && stateHeld
      && Number.isFinite(roomRate)
      && Number.isFinite(incomingRate)
      && Math.abs(roomRate - incomingRate) < 0.0001
      && this.withinOwnReport(room, payload, HOLDOVER_TIME_TOLERANCE_SECONDS);
  }

  private safeTargetTelemetry(payload: Record<string, unknown>, nowMs: number) {
    if (!this.handoff) return false;
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const reference = this.handoff.targetTimeline.hasTelemetry
      ? this.handoff.targetTimeline.statusPayload(nowMs) as Record<string, unknown>
      : room;
    const incomingState = Number(payload.state);
    const roomRate = Number(room.playbackRate);
    const incomingRate = Number(payload.playbackRate ?? 1);
    const targetState = playbackTargetState(Number(room.state));
    const stateRelevant = incomingState === BUFFERING_STATE || incomingState === targetState;

    if (
      typeof room.videoId !== 'string'
      || payload.videoId !== room.videoId
      || !stateRelevant
      || !Number.isFinite(roomRate)
      || !Number.isFinite(incomingRate)
      || Math.abs(roomRate - incomingRate) >= 0.0001
    ) return false;

    // BUFFERING remains candidate-only evidence and therefore has to be
    // continuous with the target's own reports. A final renderable proof is
    // different: after a long stall the client is expected to seek forward to
    // the live room position, so that intentional realignment may jump relative
    // to the frozen candidate clock, but it must be near authoritative serverTime.
    if (targetState === CUED_STATE) return incomingState === CUED_STATE;
    return incomingState === BUFFERING_STATE
      ? this.withinOwnReport(reference, payload, HANDOFF_TIME_TOLERANCE_SECONDS)
      : this.nearAuthoritativeRoom(playbackStartPosition(room), payload, HANDOFF_TIME_TOLERANCE_SECONDS);
  }

  private targetTelemetryCompletes(payload: Record<string, unknown>, nowMs: number) {
    if (!this.handoff) return false;
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const incomingState = Number(payload.state);
    if (incomingState === BUFFERING_STATE) return false;
    return incomingState === playbackTargetState(Number(room.state));
  }

  private handoffPlan(nowMs: number): SongHandoffPlan | null {
    if (!this.handoff) return null;
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    if (
      typeof room.videoId !== 'string'
      || !Number.isFinite(Number(room.serverTime))
      || !Number.isFinite(Number(room.state))
      || !Number.isFinite(Number(room.playbackRate))
    ) return null;

    const roomState = Number(room.state);
    return {
      handoffId: this.handoff.id,
      revision: this.revisionValue,
      target: { ...this.handoff.target },
      videoId: room.videoId,
      state: playbackTargetState(roomState),
      serverTime: playbackStartPosition(room),
      playbackRate: Number(room.playbackRate),
    };
  }

  private newHandoff(
    id: string,
    target: PlaybackIdentity,
    nowMs: number,
    startedAtMs = nowMs,
  ): Handoff {
    return {
      id,
      target,
      state: 'preparing',
      startedAtMs,
      commitStartedAtMs: null,
      readyAcknowledged: false,
      announcedState: playbackTargetState(this.timeline.statusPayload(nowMs).state),
      targetTimeline: new YouTubeTimelineTracker(),
    };
  }

  private cancelFailedHandoff(micOwnerId: string | null) {
    if (!this.handoff) return false;
    const leader = this.leaderIdentity();
    this.failedHandoffHoldover = leader && micOwnerId === this.handoff.target.participantId ? {
      leader,
      micOwnerId,
    } : null;
    this.handoff = null;
    this.bump();
    return true;
  }

  private normalizeIdentity(identity: PlaybackIdentity): PlaybackIdentity | null {
    const participantId = typeof identity?.participantId === 'string'
      ? identity.participantId.trim()
      : '';
    const transportId = normalizePlaybackTransportId(identity?.transportId);
    const generation = normalizePlaybackGeneration(identity?.generation);
    if (!participantId || !transportId || generation === null) return null;
    return { participantId, transportId, generation };
  }

  private sameIdentity(a: PlaybackIdentity | null, b: PlaybackIdentity) {
    return Boolean(
      a
      && a.participantId === b.participantId
      && a.transportId === b.transportId
      && a.generation === b.generation,
    );
  }

  private leaderAuthorityFresh(
    nowMs: number,
    timeline: { connected?: boolean } = this.timeline.statusPayload(nowMs),
  ) {
    return this.leader !== null
      && nowMs - this.leader.lastTelemetryAtMs <= LEADER_STALE_AFTER_MS
      && timeline.connected === true;
  }

  /** The playback tab whose telemetry drives the room song. */
  leaderIdentity(): PlaybackIdentity | null {
    return this.leader ? {
      participantId: this.leader.participantId,
      transportId: this.leader.transportId,
      generation: this.leader.generation,
    } : null;
  }

  private semanticTimelineChanged(before: Record<string, unknown>, after: Record<string, unknown>) {
    return before.videoId !== after.videoId
      || before.state !== after.state
      || before.playbackRate !== after.playbackRate
      || before.corrections !== after.corrections;
  }

  private bump() {
    this.revisionValue += 1;
  }
}
