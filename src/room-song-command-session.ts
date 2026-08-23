import type { RoomSongCommandBody, RoomSongCommandRequest } from './room-song-command.js';
import { SERVER_INCARNATION } from './server-incarnation.js';
import { LEGACY_PLAYBACK_PARTICIPANT_ID, type PlaybackIdentity } from './song-session.js';
import { LEADER_HOLD_GRACE_MS } from '../public/playback-policy.js';
import {
  ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS,
  ROOM_SONG_POSITION_TOLERANCE_SECONDS,
  ROOM_SONG_TERMINAL_RELOAD_TOLERANCE_SECONDS,
  roomSongCommandConvergence,
  type RoomSongConvergenceStage,
} from '../public/room-song-command-convergence.js';
import {
  roomSongObservedMutations,
  roomSongPendingOwnsMutation,
} from '../public/room-song-command-mutations.js';

const COMMAND_TIMEOUT_MS = 4_000;
const MAX_RECENT_COMMANDS = 64;
const ENDED = 0;

type DesiredPlaybackState = 1 | 2 | 5;
type RoomSongStatus = Record<string, unknown>;

export type RoomSongDesiredState = {
  videoId: string;
  positionSeconds: number;
  state: DesiredPlaybackState;
  playbackRate: number;
  /** True only when this command semantically asks the player to reposition. */
  mustApplyPosition: boolean;
  /** The authoritative room reached YouTube ENDED rather than pausing there. */
  ended: boolean;
};

export type AppliedRoomSongCommandBody = RoomSongCommandBody & {
  desired: RoomSongDesiredState;
};

export type AcceptedRoomSongCommand = {
  commandId: string;
  expectedRevision: number;
  supersedesCommandId: string | null;
  revision: number;
  issuedByParticipantId: string;
  target: PlaybackIdentity;
  body: AppliedRoomSongCommandBody;
};

type PendingRoomSongCommand = AcceptedRoomSongCommand & {
  issuedAtMs: number;
};

export type RoomSongCommandDecision =
  | { ok: true; command: AcceptedRoomSongCommand; duplicate: boolean }
  | {
    ok: false;
    reason:
      | 'invalid-identity'
      | 'stale-revision'
      | 'supersession-mismatch'
      | 'handoff-active'
      | 'mic-owner-required'
      | 'playback-leader-required'
      | 'playback-handoff-required'
      | 'song-required'
      | 'command-pending'
      | 'command-id-conflict';
  };

export type RoomSongTelemetryGate =
  | { ok: true; completesCommandId?: string }
  | {
    ok: false;
    reason: 'command-required' | 'command-target-mismatch' | 'command-mismatch';
  };

function sameIdentity(a: PlaybackIdentity | null, b: PlaybackIdentity) {
  return Boolean(
    a
    && a.participantId === b.participantId
    && a.transportId === b.transportId
    && a.generation === b.generation,
  );
}

function normalizeParticipantId(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function statusLeader(status: RoomSongStatus): PlaybackIdentity | null {
  const participantId = normalizeParticipantId(status.playbackLeaderParticipantId);
  const transportId = typeof status.playbackTransportId === 'string'
    ? status.playbackTransportId
    : '';
  const generation = Number(status.playbackGeneration);
  if (!participantId || !transportId || !Number.isInteger(generation) || generation < 0) return null;
  return { participantId, transportId, generation };
}

function statusLeaderHolding(status: RoomSongStatus, leader: PlaybackIdentity | null) {
  if (!leader || status.leaderConnected !== true) return false;
  if (status.leaderFresh === true) return true;
  const ageMs = Number(status.ageMs);
  return Number.isFinite(ageMs)
    ? ageMs <= LEADER_HOLD_GRACE_MS
    : status.connected !== false;
}

function statusHandoffTarget(status: RoomSongStatus): PlaybackIdentity | null {
  const participantId = normalizeParticipantId(status.handoffTargetParticipantId);
  const transportId = typeof status.handoffTargetPlaybackTransportId === 'string'
    ? status.handoffTargetPlaybackTransportId
    : '';
  const generation = Number(status.handoffTargetPlaybackGeneration);
  if (!participantId || !transportId || !Number.isInteger(generation) || generation < 0) return null;
  return { participantId, transportId, generation };
}

function safeTerminalReloadContinuation(
  payload: Record<string, unknown>,
  identity: PlaybackIdentity,
  roomStatus: RoomSongStatus,
) {
  const leader = statusLeader(roomStatus);
  if (
    !leader
    || leader.participantId !== identity.participantId
    || leader.transportId !== identity.transportId
    || identity.generation <= leader.generation
  ) return false;

  const roomState = Number(roomStatus.state);
  const incomingState = Number(payload.state);
  if (![0, -1].includes(roomState) || incomingState !== 2) return false;

  const roomVideoId = typeof roomStatus.videoId === 'string' ? roomStatus.videoId : null;
  const incomingVideoId = typeof payload.videoId === 'string' ? payload.videoId : null;
  if (!roomVideoId || incomingVideoId !== roomVideoId) return false;

  const roomRate = Number(roomStatus.playbackRate ?? 1);
  const incomingRate = Number(payload.playbackRate ?? 1);
  if (
    !Number.isFinite(roomRate)
    || !Number.isFinite(incomingRate)
    || Math.abs(roomRate - incomingRate) > 0.0001
  ) return false;

  const roomPosition = Number(roomStatus.serverTime);
  const incomingPosition = Number(payload.currentTime);
  if (
    !Number.isFinite(roomPosition)
    || !Number.isFinite(incomingPosition)
    || Math.abs(roomPosition - incomingPosition) > ROOM_SONG_TERMINAL_RELOAD_TOLERANCE_SECONDS
  ) return false;

  return true;
}

function sameCommandBody(a: RoomSongCommandBody, b: RoomSongCommandBody) {
  if (a.action !== b.action) return false;
  if (a.action === 'load' && b.action === 'load') {
    return a.videoId === b.videoId && a.positionSeconds === b.positionSeconds;
  }
  if (a.action === 'seek' && b.action === 'seek') return a.positionSeconds === b.positionSeconds;
  if (a.action === 'rate' && b.action === 'rate') return a.playbackRate === b.playbackRate;
  return true;
}

function desiredPlaybackState(value: unknown): DesiredPlaybackState {
  const state = Number(value);
  if (state === 1 || state === 3) return 1;
  if (state === ENDED || state === 2) return 2;
  return 5;
}

function desiredFromRoom(status: RoomSongStatus): RoomSongDesiredState | null {
  const videoId = typeof status.videoId === 'string' ? status.videoId : null;
  const positionSeconds = Number(status.serverTime);
  const playbackRate = Number(status.playbackRate ?? 1);
  if (!videoId || !Number.isFinite(positionSeconds) || positionSeconds < 0) return null;
  return {
    videoId,
    positionSeconds,
    state: desiredPlaybackState(status.state),
    playbackRate: Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
    // Describing the room position is not authority to move the player there.
    mustApplyPosition: false,
    ended: Number(status.state) === ENDED,
  };
}

function projectDesired(command: PendingRoomSongCommand, nowMs: number): RoomSongDesiredState {
  const desired = command.body.desired;
  // Position-bearing commands use action semantics: the position is the exact
  // target to apply when the browser receives the command. Delivery/queue age
  // before apply must never advance Seek/Load/Replay (or an inherited Seek).
  // State/rate-only commands may still project their descriptive position so
  // the mutation gate can bound causal clock motion while they are pending.
  const elapsedSeconds = desired.state === 1 && desired.mustApplyPosition === false
    ? Math.max(0, nowMs - command.issuedAtMs) / 1000
    : 0;
  return {
    ...desired,
    positionSeconds: Math.max(0, desired.positionSeconds + elapsedSeconds * desired.playbackRate),
  };
}

function foldDesired(
  base: RoomSongDesiredState | null,
  body: RoomSongCommandBody,
): RoomSongDesiredState | null {
  if (body.action === 'load') {
    return {
      videoId: body.videoId,
      positionSeconds: body.positionSeconds,
      state: 5,
      playbackRate: base?.playbackRate ?? 1,
      mustApplyPosition: true,
      ended: false,
    };
  }
  if (!base) return null;

  if (body.action === 'play') {
    // Replay is the one Play whose position is part of the command itself.
    return base.ended
      ? { ...base, state: 1, positionSeconds: 0, ended: false, mustApplyPosition: true }
      : { ...base, state: 1 };
  }
  if (body.action === 'pause') return { ...base, state: 2 };
  if (body.action === 'seek') {
    return { ...base, positionSeconds: body.positionSeconds, ended: false, mustApplyPosition: true };
  }
  return { ...base, playbackRate: body.playbackRate };
}

/**
 * Owns room-song intent ordering and semantic proof. SongSession remains the
 * playback-leader/media-clock authority.
 */
export class RoomSongCommandSession {
  private pending: PendingRoomSongCommand | null = null;
  // State/rate-only commands deliberately do not own position. Their first
  // PLAYING/PAUSED/rate match is not enough to retire command provenance because
  // the YouTube iframe may still issue a late media-clock correction. Require
  // two consecutive complete observations whose *local* timeline deltas are
  // below the same jump boundary used to infer a native Seek. Any jump resets
  // the candidate instead of turning the command terminal too early.
  private stableCompleteProofCommandId: string | null = null;
  private readonly recent = new Map<string, AcceptedRoomSongCommand>();

  begin(
    request: RoomSongCommandRequest,
    actorParticipantIdInput: string,
    requesterPlayback: PlaybackIdentity,
    micOwnerId: string | null,
    roomStatus: RoomSongStatus,
    currentRevision: number,
    nextRevision: number,
    nowMs: number,
  ): RoomSongCommandDecision {
    this.expire(nowMs);

    const actorParticipantId = normalizeParticipantId(actorParticipantIdInput);
    if (!actorParticipantId || requesterPlayback.participantId !== actorParticipantId) {
      return { ok: false, reason: 'invalid-identity' };
    }

    const leader = statusLeader(roomStatus);
    const healthyLeader = Boolean(
      leader
      && roomStatus.leaderConnected === true
      && roomStatus.leaderFresh === true,
    );
    const heldLeader = statusLeaderHolding(roomStatus, leader);
    const target = micOwnerId === null
      && request.body.action === 'load'
      && heldLeader
      && leader
      ? leader
      : requesterPlayback;

    const prior = this.recent.get(request.commandId);
    if (prior) {
      if (
        prior.issuedByParticipantId === actorParticipantId
        && sameIdentity(prior.target, target)
        && prior.supersedesCommandId === request.supersedesCommandId
        && sameCommandBody(prior.body, request.body)
      ) {
        return { ok: true, command: this.publicCommand(prior), duplicate: true };
      }
      return { ok: false, reason: 'command-id-conflict' };
    }

    if (roomStatus.handoffState && roomStatus.handoffState !== 'idle') {
      return { ok: false, reason: 'handoff-active' };
    }

    if (micOwnerId !== null) {
      if (actorParticipantId !== micOwnerId) {
        return { ok: false, reason: 'mic-owner-required' };
      }
      if (healthyLeader && leader && !sameIdentity(leader, target)) {
        if (leader.participantId !== micOwnerId) {
          return { ok: false, reason: 'playback-handoff-required' };
        }
        if (!(
          leader.participantId === target.participantId
          && leader.transportId === target.transportId
          && target.generation > leader.generation
        )) {
          return { ok: false, reason: 'playback-leader-required' };
        }
      }
    } else if (healthyLeader && leader && !sameIdentity(leader, target)) {
      if (!(
        leader.participantId === target.participantId
        && leader.transportId === target.transportId
        && target.generation > leader.generation
      )) {
        return { ok: false, reason: 'playback-leader-required' };
      }
    }

    let causalPredecessor: AcceptedRoomSongCommand | null = null;
    if (request.supersedesCommandId) {
      const candidate = this.recent.get(request.supersedesCommandId) ?? null;
      if (
        !candidate
        || candidate.issuedByParticipantId !== actorParticipantId
        || !sameIdentity(candidate.target, target)
      ) {
        return { ok: false, reason: 'supersession-mismatch' };
      }

      const isPendingPredecessor = this.pending?.commandId === candidate.commandId;
      const isLatestTerminalPredecessor = this.pending === null && candidate.revision === currentRevision;
      if (!isPendingPredecessor && !isLatestTerminalPredecessor) {
        return { ok: false, reason: 'supersession-mismatch' };
      }
      if (
        request.expectedRevision !== currentRevision
        && request.expectedRevision !== candidate.expectedRevision
      ) {
        return { ok: false, reason: 'stale-revision' };
      }
      causalPredecessor = candidate;
    } else {
      if (request.expectedRevision !== currentRevision) {
        return { ok: false, reason: 'stale-revision' };
      }
      if (this.pending) return { ok: false, reason: 'command-pending' };
    }

    const baseDesired = this.pending && causalPredecessor?.commandId === this.pending.commandId
      ? projectDesired(this.pending, nowMs)
      : desiredFromRoom(roomStatus);
    const desired = foldDesired(baseDesired, request.body);
    if (!desired) return { ok: false, reason: 'song-required' };

    const command: PendingRoomSongCommand = {
      commandId: request.commandId,
      expectedRevision: request.expectedRevision,
      supersedesCommandId: request.supersedesCommandId,
      revision: nextRevision,
      issuedByParticipantId: actorParticipantId,
      target: { ...target },
      body: { ...request.body, desired } as AppliedRoomSongCommandBody,
      issuedAtMs: nowMs,
    };

    this.pending = command;
    this.stableCompleteProofCommandId = null;
    const accepted = this.publicCommand(command);
    this.recent.set(command.commandId, accepted);
    while (this.recent.size > MAX_RECENT_COMMANDS) {
      const oldest = this.recent.keys().next().value as string | undefined;
      if (!oldest) break;
      this.recent.delete(oldest);
    }
    return { ok: true, command: accepted, duplicate: false };
  }

  gateTelemetry(
    payload: Record<string, unknown>,
    identity: PlaybackIdentity,
    roomStatus: RoomSongStatus,
    nowMs: number,
  ): RoomSongTelemetryGate {
    this.expire(nowMs);

    if (identity.participantId === LEGACY_PLAYBACK_PARTICIPANT_ID) return { ok: true };

    const mutations = roomSongObservedMutations({ observed: payload, room: roomStatus });
    if (this.pending) {
      if (!sameIdentity(this.pending.target, identity)) {
        return { ok: false, reason: 'command-target-mismatch' };
      }

      const projected = projectDesired(this.pending, nowMs);
      for (const mutation of mutations) {
        if (!roomSongPendingOwnsMutation({
          mutation,
          commandAction: this.pending.body.action,
          desired: this.pending.body.desired,
          currentTime: Number(payload.currentTime),
          projectedPositionSeconds: projected.positionSeconds,
        })) {
          this.stableCompleteProofCommandId = null;
          return { ok: false, reason: 'command-mismatch' };
        }
      }

      const convergence = this.pendingConvergence(payload, this.pending, nowMs);
      if (convergence === 'complete') {
        // Position-bearing commands already prove the full mutation state in one
        // observation. State/rate-only commands need stable local-clock proof so
        // a delayed iframe correction cannot race terminal completion.
        if (this.pending.body.desired.mustApplyPosition) {
          return { ok: true, completesCommandId: this.pending.commandId };
        }

        // The current production client always supplies its local timeline delta.
        // Keep one-shot completion for an older envelope that genuinely lacks the
        // field; malformed present data never counts as stable proof.
        if (payload.timelineDeltaSeconds === undefined) {
          return { ok: true, completesCommandId: this.pending.commandId };
        }
        const localDeltaSeconds = Number(payload.timelineDeltaSeconds);
        const stableLocalClock = Number.isFinite(localDeltaSeconds)
          && Math.abs(localDeltaSeconds) <= ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS;
        if (!stableLocalClock) {
          this.stableCompleteProofCommandId = null;
          return { ok: true };
        }
        if (this.stableCompleteProofCommandId === this.pending.commandId) {
          return { ok: true, completesCommandId: this.pending.commandId };
        }
        this.stableCompleteProofCommandId = this.pending.commandId;
        return { ok: true };
      }

      this.stableCompleteProofCommandId = null;
      if (convergence === 'intermediate') {
        return { ok: true };
      }
      // A `none` observation is only safe while the player is still showing the
      // stable pre-command state. If it contains any semantic mutation, it is
      // evidence for some other (or superseded) intent and must not pass as
      // progress toward the latest pending command.
      return mutations.size === 0
        ? { ok: true }
        : { ok: false, reason: 'command-mismatch' };
    }

    // A handoff commit is an independent authorization that can outlive the
    // command which started it.
    if (
      roomStatus.handoffState === 'committing'
      && sameIdentity(statusHandoffTarget(roomStatus), identity)
    ) {
      return { ok: true };
    }

    if (safeTerminalReloadContinuation(payload, identity, roomStatus)) {
      return { ok: true };
    }

    // Once the established leader's own reports are stale, allow only its clock
    // position to re-anchor. Video/rate/state still require an explicit command.
    if (
      mutations.size === 1
      && mutations.has('seek')
      && roomStatus.connected === false
      && sameIdentity(statusLeader(roomStatus), identity)
    ) {
      return { ok: true };
    }

    return mutations.size === 0
      ? { ok: true }
      : { ok: false, reason: 'command-required' };
  }

  complete(commandId: string) {
    if (!this.pending || this.pending.commandId !== commandId) return false;
    this.pending = null;
    this.stableCompleteProofCommandId = null;
    return true;
  }

  fail(identity: PlaybackIdentity, commandId: unknown) {
    if (
      !this.pending
      || commandId !== this.pending.commandId
      || !sameIdentity(this.pending.target, identity)
    ) return false;
    this.pending = null;
    this.stableCompleteProofCommandId = null;
    return true;
  }

  cancelPending() {
    if (!this.pending) return null;
    const cancelled = this.publicCommand(this.pending);
    this.pending = null;
    this.stableCompleteProofCommandId = null;
    return cancelled;
  }

  cancelSupersededTransport(identity: PlaybackIdentity) {
    if (!this.pending) return null;
    const target = this.pending.target;
    if (
      target.participantId !== identity.participantId
      || target.transportId !== identity.transportId
      || identity.generation <= target.generation
    ) return null;

    const cancelled = this.publicCommand(this.pending);
    this.pending = null;
    this.stableCompleteProofCommandId = null;
    return cancelled;
  }

  pendingForTarget(identity: PlaybackIdentity, nowMs: number) {
    this.expire(nowMs);
    if (this.cancelSupersededTransport(identity)) return null;
    if (!this.pending || !sameIdentity(this.pending.target, identity)) return null;
    return this.publicCommand(this.pending);
  }

  sweep(nowMs: number) {
    const pending = this.pending ? this.publicCommand(this.pending) : null;
    this.expire(nowMs);
    return pending && this.pending === null ? pending : null;
  }

  statusPayload(revision: number, nowMs: number) {
    this.expire(nowMs);
    return {
      type: 'room-song-command-status',
      serverIncarnation: SERVER_INCARNATION,
      revision,
      pendingCommandId: this.pending?.commandId ?? null,
      pendingAction: this.pending?.body.action ?? null,
      pendingSupersedesCommandId: this.pending?.supersedesCommandId ?? null,
    };
  }

  private expire(nowMs: number) {
    if (this.pending && nowMs - this.pending.issuedAtMs > COMMAND_TIMEOUT_MS) {
      this.pending = null;
      this.stableCompleteProofCommandId = null;
    }
  }

  private publicCommand(command: AcceptedRoomSongCommand) {
    return {
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
      supersedesCommandId: command.supersedesCommandId,
      revision: command.revision,
      issuedByParticipantId: command.issuedByParticipantId,
      target: { ...command.target },
      body: {
        ...command.body,
        desired: { ...command.body.desired },
      } as AppliedRoomSongCommandBody,
    } satisfies AcceptedRoomSongCommand;
  }

  private pendingConvergence(
    payload: Record<string, unknown>,
    command: PendingRoomSongCommand,
    nowMs: number,
  ): RoomSongConvergenceStage {
    const desired = projectDesired(command, nowMs);
    return roomSongCommandConvergence({
      desired,
      observed: {
        videoId: typeof payload.videoId === 'string' ? payload.videoId : null,
        currentTime: Number(payload.currentTime),
        state: Number(payload.state),
        playbackRate: Number(payload.playbackRate ?? 1),
      },
      projectedPositionSeconds: desired.positionSeconds,
      requirePosition: desired.mustApplyPosition,
    });
  }
}
