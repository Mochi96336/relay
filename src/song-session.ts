import { performance } from 'node:perf_hooks';

import { YouTubeTimelineTracker } from './youtube-timeline.js';

const LEADER_STALE_AFTER_MS = 1_500;
const HANDOFF_TIME_TOLERANCE_SECONDS = 1.5;
/**
 * How long a target may leave a prepared handoff unacknowledged.
 *
 * A live handoff deliberately freezes the room song: the old leader may only
 * repeat what it is already playing, and no other transport may touch the
 * clock at all. That is correct for the seconds a real handoff takes and
 * intolerable for anything longer, so a target that never answers the plan
 * must not be able to hold the room indefinitely.
 */
const HANDOFF_PREPARE_TIMEOUT_MS = 20_000;
/**
 * A commit should be a short proof window, not another indefinite state.
 *
 * Once the target says it is ready the old leader is still kept alive until
 * matching target telemetry arrives. If that proof never appears, roll the
 * handoff back to preparation so a later retry has to cross the ready boundary
 * again instead of leaving the room stuck in `committing` forever.
 */
const HANDOFF_COMMIT_TIMEOUT_MS = 5_000;
const HOLDOVER_TIME_TOLERANCE_SECONDS = 0.9;
/** YT.PlayerState.BUFFERING: on its way to a state, not refusing one. */
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
  /**
   * Whether the target has ever reported itself prepared.
   *
   * A target that has acknowledged the plan and explicitly returned to
   * preparation (for example because autoplay needs a real user gesture) is
   * trusted to wait there. The short-lived `committing` phase has its own
   * deadline above because it is only waiting for proof telemetry.
   */
  everReady: boolean;
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
 * acquisition. The target is cued first, then committed, and only valid target
 * telemetry completes the handoff.
 */
export class SongSession {
  private readonly timeline = new YouTubeTimelineTracker();
  private leader: Leader | null = null;
  private handoff: Handoff | null = null;
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

    this.handoffSequence += 1;
    this.handoff = {
      id: `song-handoff-${this.handoffSequence}`,
      target,
      state: 'preparing',
      startedAtMs: nowMs,
      commitStartedAtMs: null,
      everReady: false,
    };
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
      this.handoff = {
        id: `song-handoff-${this.handoffSequence}`,
        target: identity,
        state: 'preparing',
        startedAtMs: nowMs,
        commitStartedAtMs: null,
        everReady: false,
      };
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

    this.handoff.everReady = true;
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
    this.bump();
    return true;
  }

  cancelHandoff() {
    if (!this.handoff) return false;
    this.handoff = null;
    this.bump();
    return true;
  }

  /** The transport a live handoff is waiting for, so callers can check it still exists. */
  handoffTarget(): PlaybackIdentity | null {
    return this.handoff ? { ...this.handoff.target } : null;
  }

  /**
   * Abandons a handoff whose target is never going to answer and rolls a stale
   * commit back to preparation while preserving the old playback leader.
   *
   * `targetPresent` is supplied by the caller because SongSession does not know
   * about sockets. Without this, closing the tab that was about to take over
   * left the room frozen for good: the old leader restricted to repeating
   * itself, every other transport refused as `handoff-not-target`, and the only
   * escapes were releasing the microphone or leaving the room.
   */
  sweepHandoff(targetPresent: boolean, nowMs = performance.now()) {
    if (!this.handoff) return false;
    if (!targetPresent) return this.cancelHandoff();

    if (
      this.handoff.state === 'committing'
      && this.handoff.commitStartedAtMs !== null
      && nowMs - this.handoff.commitStartedAtMs > HANDOFF_COMMIT_TIMEOUT_MS
    ) {
      this.handoff.state = 'preparing';
      this.handoff.commitStartedAtMs = null;
      this.bump();
      // This is deliberately not a cancellation. The server's sweep caller
      // interprets true as "send song-handoff-cancelled"; returning false keeps
      // the target locked and requires it to cross the ready boundary again.
      return false;
    }

    if (this.handoff.everReady) return false;
    if (nowMs - this.handoff.startedAtMs <= HANDOFF_PREPARE_TIMEOUT_MS) return false;
    return this.cancelHandoff();
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

    // Validate the media payload before granting authority. A malformed packet
    // must never be able to steal the room clock merely by arriving first.
    const before = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    if (!this.timeline.update(payload, nowMs)) {
      return { accepted: false, reason: 'invalid-telemetry', leaderChanged: false };
    }

    const completingHandoff = Boolean(
      this.handoff
      && this.handoff.state === 'committing'
      && this.sameIdentity(this.handoff.target, identity),
    );
    const completedHandoffId = completingHandoff ? this.handoff!.id : undefined;
    const previousLeader = completingHandoff ? this.leaderIdentity() : undefined;

    const leaderChanged = !this.sameIdentity(this.leader, identity);
    if (leaderChanged) {
      this.leader = {
        ...identity,
        connected: true,
        lastTelemetryAtMs: nowMs,
      };
      if (completingHandoff) this.handoff = null;
      this.bump();
    } else if (this.leader) {
      this.leader.connected = true;
      this.leader.lastTelemetryAtMs = nowMs;
      if (completingHandoff) {
        this.handoff = null;
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
    const room = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    const desiredState = Number(room.state);
    const incomingState = Number(payload.state);
    // A target that has just been told to take a song is loading it, and a
    // phone loading a video reports BUFFERING before it reports playing.
    // Requiring the finished state here meant a handoff could only complete on
    // a device that never had to buffer, which is not a phone.
    const stateReady = incomingState === BUFFERING_STATE
      || (desiredState === 1 ? incomingState === 1 : [0, 2, 5].includes(incomingState));

    return typeof room.videoId === 'string'
      && payload.videoId === room.videoId
      && stateReady
      && this.withinOwnReport(room, payload, HANDOFF_TIME_TOLERANCE_SECONDS);
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

    return {
      handoffId: this.handoff.id,
      revision: this.revisionValue,
      target: { ...this.handoff.target },
      videoId: room.videoId,
      state: Number(room.state),
      serverTime: Number(room.serverTime),
      playbackRate: Number(room.playbackRate),
    };
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
