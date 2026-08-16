import type { RoomSongCommandBody, RoomSongCommandRequest } from './room-song-command.js';
import type { PlaybackIdentity } from './song-session.js';

const COMMAND_TIMEOUT_MS = 4_000;
const SEEK_MUTATION_THRESHOLD_SECONDS = 0.75;
const COMMAND_POSITION_TOLERANCE_SECONDS = 1.5;
const MAX_RECENT_COMMANDS = 64;

type DesiredPlaybackState = 1 | 2 | 5;

export type RoomSongDesiredState = {
  videoId: string;
  positionSeconds: number;
  state: DesiredPlaybackState;
  playbackRate: number;
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

type RoomSongStatus = Record<string, unknown>;

type CommandMutation = RoomSongCommandBody['action'] | null;

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
  if (state === 0 || state === 2) return 2;
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
  };
}

function projectDesired(command: PendingRoomSongCommand, nowMs: number): RoomSongDesiredState {
  const desired = command.body.desired;
  const elapsedSeconds = desired.state === 1
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
    };
  }
  if (!base) return null;
  if (body.action === 'play') return { ...base, state: 1 };
  if (body.action === 'pause') return { ...base, state: 2 };
  if (body.action === 'seek') return { ...base, positionSeconds: body.positionSeconds };
  return { ...base, playbackRate: body.playbackRate };
}

/**
 * Room-song command/intent gate.
 *
 * Phase 1A established the one server-authoritative mutation path. Phase 1B
 * lets the same exact actor/target advance that path while an earlier command
 * is still pending. Each successor names its causal predecessor and is folded
 * into a complete desired playback state, so the latest accepted intent can be
 * applied on its own even when older applies/telemetry arrive late.
 *
 * SongSession still owns playback-leader/media-clock authority. This class
 * owns only product intent ordering, command revisions and semantic proof.
 */
export class RoomSongCommandSession {
  private pending: PendingRoomSongCommand | null = null;
  private readonly recent = new Map<string, AcceptedRoomSongCommand>();

  begin(
    request: RoomSongCommandRequest,
    actorParticipantIdInput: string,
    target: PlaybackIdentity,
    micOwnerId: string | null,
    roomStatus: RoomSongStatus,
    currentRevision: number,
    nextRevision: number,
    nowMs: number,
  ): RoomSongCommandDecision {
    this.expire(nowMs);

    const actorParticipantId = normalizeParticipantId(actorParticipantIdInput);
    if (!actorParticipantId || target.participantId !== actorParticipantId) {
      return { ok: false, reason: 'invalid-identity' };
    }

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

    const leader = statusLeader(roomStatus);
    const leaderConnected = roomStatus.leaderConnected === true;
    const leaderFresh = roomStatus.leaderFresh === true;
    const healthyLeader = Boolean(leader && leaderConnected && leaderFresh);

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
      body: {
        ...request.body,
        desired,
      } as AppliedRoomSongCommandBody,
      issuedAtMs: nowMs,
    };

    this.pending = command;
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

    // The narrow pre-participant compatibility publisher predates room song
    // commands. It remains a compatibility boundary, not a production bypass
    // for identified participants.
    if (identity.participantId === '__relay_legacy_publisher__') return { ok: true };

    const mutation = this.detectMutation(payload, roomStatus);
    if (this.pending) {
      if (!sameIdentity(this.pending.target, identity)) {
        return { ok: false, reason: 'command-target-mismatch' };
      }

      if (this.matchesPending(payload, this.pending, nowMs)) {
        return { ok: true, completesCommandId: this.pending.commandId };
      }

      if (mutation !== null) return { ok: false, reason: 'command-mismatch' };
      return { ok: true };
    }

    return mutation === null
      ? { ok: true }
      : { ok: false, reason: 'command-required' };
  }

  complete(commandId: string) {
    if (!this.pending || this.pending.commandId !== commandId) return false;
    this.pending = null;
    return true;
  }

  fail(identity: PlaybackIdentity, commandId: unknown) {
    if (
      !this.pending
      || commandId !== this.pending.commandId
      || !sameIdentity(this.pending.target, identity)
    ) return false;
    this.pending = null;
    return true;
  }

  cancelPending() {
    if (!this.pending) return null;
    const cancelled = this.publicCommand(this.pending);
    this.pending = null;
    return cancelled;
  }

  pendingForTarget(identity: PlaybackIdentity, nowMs: number) {
    this.expire(nowMs);
    if (!this.pending || !sameIdentity(this.pending.target, identity)) return null;
    return this.publicCommand(this.pending);
  }

  sweep(nowMs: number) {
    const hadPending = this.pending !== null;
    this.expire(nowMs);
    return hadPending && this.pending === null;
  }

  statusPayload(revision: number, nowMs: number) {
    this.expire(nowMs);
    return {
      type: 'room-song-command-status',
      revision,
      pendingCommandId: this.pending?.commandId ?? null,
      pendingAction: this.pending?.body.action ?? null,
      pendingSupersedesCommandId: this.pending?.supersedesCommandId ?? null,
    };
  }

  private expire(nowMs: number) {
    if (this.pending && nowMs - this.pending.issuedAtMs > COMMAND_TIMEOUT_MS) {
      this.pending = null;
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

  private detectMutation(payload: Record<string, unknown>, roomStatus: RoomSongStatus): CommandMutation {
    const incomingVideoId = typeof payload.videoId === 'string' ? payload.videoId : null;
    const roomVideoId = typeof roomStatus.videoId === 'string' ? roomStatus.videoId : null;
    if (!roomVideoId) return incomingVideoId ? 'load' : null;
    if (incomingVideoId && incomingVideoId !== roomVideoId) return 'load';

    const roomRate = Number(roomStatus.playbackRate);
    const incomingRate = Number(payload.playbackRate ?? 1);
    if (
      Number.isFinite(roomRate)
      && Number.isFinite(incomingRate)
      && Math.abs(roomRate - incomingRate) > 0.0001
    ) return 'rate';

    const roomState = Number(roomStatus.state);
    const incomingState = Number(payload.state);
    if (incomingState === 1 && ![1, 3].includes(roomState)) return 'play';
    if (incomingState === 2 && roomState !== 2) return 'pause';
    if (incomingState === 5 && roomState !== 5) return 'load';

    const roomTime = Number(roomStatus.serverTime);
    const incomingTime = Number(payload.currentTime);
    if (
      Number.isFinite(roomTime)
      && Number.isFinite(incomingTime)
      && Math.abs(roomTime - incomingTime) > SEEK_MUTATION_THRESHOLD_SECONDS
    ) return 'seek';

    return null;
  }

  private matchesPending(
    payload: Record<string, unknown>,
    command: PendingRoomSongCommand,
    nowMs: number,
  ) {
    const desired = projectDesired(command, nowMs);
    const videoId = typeof payload.videoId === 'string' ? payload.videoId : null;
    const currentTime = Number(payload.currentTime);
    const state = Number(payload.state);
    const rate = Number(payload.playbackRate ?? 1);

    if (videoId !== desired.videoId) return false;
    if (!Number.isFinite(rate) || Math.abs(rate - desired.playbackRate) > 0.0001) return false;
    if (
      !Number.isFinite(currentTime)
      || Math.abs(currentTime - desired.positionSeconds) > COMMAND_POSITION_TOLERANCE_SECONDS
    ) return false;
    if (desired.state === 1) return state === 1;
    if (desired.state === 2) return state === 2;
    return state === 2 || state === 5;
  }
}
