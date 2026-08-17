import { performance } from 'node:perf_hooks';

import { YouTubeTimelineTracker } from './youtube-timeline.js';

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

/**
 * The single synthetic playback identity shared by pre-participant clients.
 *
 * There is only ever one anonymous publisher transport at a time, so this is
 * one logical device rather than a population; each connection is a newer
 * incarnation of it, distinguished by its generation.
 *
 * It lives beside PlaybackIdentity rather than in the server module because
 * more than one authority layer has to recognise it, and two spellings of the
 * same identity would be a silent hole in whichever one drifted.
 */
export const LEGACY_PLAYBACK_PARTICIPANT_ID = '__relay_legacy_publisher__';
export const LEGACY_PLAYBACK_TRANSPORT_ID = 'legacy-publisher';

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
  state: number;
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
  /**
   * Candidate-only clock evidence. BUFFERING reports may advance this tracker
   * so a real PLAYING proof can be judged against the target's own recent
   * reports without overwriting the authoritative room timeline or leader.
   */
  targetTimeline: YouTubeTimelineTracker;
};

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
 * prepared and actually producing the same song.
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
    const target = this.normalizeIdentity(targetInput);
    if (!target || micOwnerId === null || target.participantId !== micOwnerId) return null;
    if (!this.leader || !this.hasTelemetry || this.sameIdentity(this.leader, target)) return null;

    if (this.handoff && this.sameIdentity(this.handoff.target, target)) {
      return this.handoffPlan(nowMs);
    }

    this.failedHandoffHoldover = null;
    this.handoffSequence += 1;
    this.handoff = this.newHandoff(`song-handoff-${this.handoffSequence}`, target, nowMs);
    this.bump();
    return this.handoffPlan(nowMs);
  }

  handoffPlanForTarget(identityInput: PlaybackIdentity, nowMs = performance.now()) {
    const identity = this.normalizeIdentity(identityInput);
    if (!identity || !this.handoff) return null;
    if (this.sameIdentity(this.handoff.target, identity)) return this.handoffPlan(nowMs);

    // A page reload keeps the logical playback transport but creates a newer
    // incarnation. If that exact tab was already the prepared handoff target,
    // move the plan forward instead of leaving the room frozen behind an old
    // generation that can never acknowledge it. A different tab is still a
    // different transport and may not inherit the handoff by coincidence.
    if (
      this.handoff.target.participantId === identity.participantId
      && this.handoff.target.transportId === identity.transportId
      && identity.generation > this.handoff.target.generation
    ) {
      this.handoffSequence += 1;
      this.handoff = this.newHandoff(`song-handoff-${this.handoffSequence}`, identity, nowMs);
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
    return this.handoffPlan(nowMs);
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
    if (!this.handoff) return false;
    this.handoff = null;
    this.failedHandoffHoldover = null;
    this.bump();
    return true;
  }

  /** The transport a live handoff is waiting for, so callers can check it still exists. */
  handoffTarget(): PlaybackIdentity | null {
    return this.handoff ? { ...this.handoff.target } : null;
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
  sweepHandoff(targetPresent: boolean, nowMs = performance.now()) {
    if (!this.handoff) return false;
    if (!targetPresent) return this.cancelFailedHandoff();

    if (nowMs - this.handoff.startedAtMs > HANDOFF_TOTAL_TIMEOUT_MS) {
      return this.cancelFailedHandoff();
    }

    if (
      this.handoff.state === 'committing'
      && this.handoff.commitStartedAtMs !== null
      && nowMs - this.handoff.commitStartedAtMs > HANDOFF_COMMIT_TIMEOUT_MS
    ) {
      return this.cancelFailedHandoff();
    }

    if (
      !this.handoff.readyAcknowledged
      && nowMs - this.handoff.startedAtMs > HANDOFF_PREPARE_TIMEOUT_MS
    ) {
      return this.cancelFailedHandoff();
    }

    return false;
  }

  update(
    payload: Record<string, unknown>,
    identityInput: PlaybackIdentity,
    micOwnerId: string | null,
    nowMs = performance.now(),
  ): SongTelemetryResult {
    const identity = this.normalizeIdentity(identityInput);
    if (!identity) {
      return { accepted: false, reason: 'invalid-identity', leaderChanged: false };
    }

    const authority = this.canWrite(payload, identity, micOwnerId, nowMs);
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

    // Validate the media payload before granting authority. A malformed packet
    // must never be able to steal the room clock merely by arriving first.
    const before = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    if (!this.timeline.update(payload, nowMs)) {
      return { accepted: false, reason: 'invalid-telemetry', leaderChanged: false };
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
    const leaderFresh = this.leader !== null
      && nowMs - this.leader.lastTelemetryAtMs <= LEADER_STALE_AFTER_MS;

    return {
      ...timeline,
      revision: this.revisionValue,
      playbackLeaderParticipantId: this.leader?.participantId ?? null,
      playbackTransportId: this.leader?.transportId ?? null,
      playbackGeneration: this.leader?.generation ?? null,
      leaderConnected: this.leader?.connected ?? false,
      leaderFresh,
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
      videoId: hasSong ? timeline.videoId : null,
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

    const fresh = nowMs - this.leader.lastTelemetryAtMs <= LEADER_STALE_AFTER_MS;
    if (!this.leader.connected || !fresh) return { ok: true };

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
   * Not from `serverTime`. That is where the room clock predicts a player
   * should be, and a player that rebuffers falls behind the prediction without
   * anybody seeking - so judging against it made every packet after a stall
   * look like a jump. A refused packet never reaches the timeline, so it could
   * not correct the drift it was refused for, and the refusals repeated at the
   * telemetry rate. The honest bound is that a player can only fall behind its
   * own last report by the time that has actually passed; anything further, in
   * either direction, is a real jump. The room-song command gate draws exactly
   * this line, and a handoff must not draw a different one.
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

  private safeHoldoverTelemetry(payload: Record<string, unknown>, nowMs: number) {
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const roomRate = Number(room.playbackRate);
    const incomingRate = Number(payload.playbackRate ?? 1);
    // Buffering is not a decision the singer made, so it is not a semantic
    // change. Demanding the exact room state meant the outgoing leader lost
    // its own holdover the moment its network hiccuped.
    const stateHeld = Number(payload.state) === Number(room.state)
      || Number(payload.state) === BUFFERING_STATE;

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
    const desiredState = Number(room.state);
    const incomingState = Number(payload.state);
    const roomRate = Number(room.playbackRate);
    const incomingRate = Number(payload.playbackRate ?? 1);
    const desiredPlaying = desiredState === 1 || desiredState === BUFFERING_STATE;
    const stateRelevant = incomingState === BUFFERING_STATE
      || (desiredPlaying ? incomingState === 1 : [0, 2, 5].includes(incomingState));

    return typeof room.videoId === 'string'
      && payload.videoId === room.videoId
      && stateRelevant
      && Number.isFinite(roomRate)
      && Number.isFinite(incomingRate)
      && Math.abs(roomRate - incomingRate) < 0.0001
      && this.withinOwnReport(reference, payload, HANDOFF_TIME_TOLERANCE_SECONDS);
  }

  private targetTelemetryCompletes(payload: Record<string, unknown>, nowMs: number) {
    if (!this.handoff) return false;
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const desiredState = Number(room.state);
    const incomingState = Number(payload.state);
    if (incomingState === BUFFERING_STATE) return false;
    if (desiredState === 1 || desiredState === BUFFERING_STATE) return incomingState === 1;
    return [0, 2, 5].includes(incomingState);
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
      state: roomState === BUFFERING_STATE ? 1 : roomState,
      serverTime: Number(room.serverTime),
      playbackRate: Number(room.playbackRate),
    };
  }

  private newHandoff(id: string, target: PlaybackIdentity, nowMs: number): Handoff {
    return {
      id,
      target,
      state: 'preparing',
      startedAtMs: nowMs,
      commitStartedAtMs: null,
      readyAcknowledged: false,
      targetTimeline: new YouTubeTimelineTracker(),
    };
  }

  private cancelFailedHandoff() {
    if (!this.handoff) return false;
    const leader = this.leaderIdentity();
    this.failedHandoffHoldover = leader ? {
      leader,
      micOwnerId: this.handoff.target.participantId,
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

  private leaderIdentity(): PlaybackIdentity | null {
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
