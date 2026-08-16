import type { RoomSongCommandBody, RoomSongCommandRequest } from './room-song-command.js';
import type { PlaybackIdentity } from './song-session.js';

const COMMAND_TIMEOUT_MS = 4_000;
const SEEK_MUTATION_THRESHOLD_SECONDS = 0.75;
const COMMAND_POSITION_TOLERANCE_SECONDS = 1.5;
const MAX_RECENT_COMMANDS = 64;

export type AcceptedRoomSongCommand = {
  commandId: string;
  expectedRevision: number;
  revision: number;
  issuedByParticipantId: string;
  target: PlaybackIdentity;
  body: RoomSongCommandBody;
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

/**
 * Serial room-song command gate for Phase 1A.
 *
 * This class deliberately does not decide media-clock authority; SongSession
 * still owns that. It establishes a single product-command path in front of
 * semantic media mutations and leaves replacement/latest-intent policy for 1B.
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
        && sameCommandBody(prior.body, request.body)
      ) {
        return { ok: true, command: prior, duplicate: true };
      }
      return { ok: false, reason: 'command-id-conflict' };
    }

    if (request.expectedRevision !== currentRevision) {
      return { ok: false, reason: 'stale-revision' };
    }

    if (roomStatus.handoffState && roomStatus.handoffState !== 'idle') {
      return { ok: false, reason: 'handoff-active' };
    }

    if (this.pending) return { ok: false, reason: 'command-pending' };

    const hasSong = typeof roomStatus.videoId === 'string';
    if (!hasSong && request.body.action !== 'load') {
      return { ok: false, reason: 'song-required' };
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

    const command: PendingRoomSongCommand = {
      commandId: request.commandId,
      expectedRevision: request.expectedRevision,
      revision: nextRevision,
      issuedByParticipantId: actorParticipantId,
      target: { ...target },
      body: request.body,
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

      if (this.matchesPending(payload, this.pending, roomStatus)) {
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
    };
  }

  private expire(nowMs: number) {
    if (this.pending && nowMs - this.pending.issuedAtMs > COMMAND_TIMEOUT_MS) {
      this.pending = null;
    }
  }

  private publicCommand(command: PendingRoomSongCommand): AcceptedRoomSongCommand {
    return {
      commandId: command.commandId,
      expectedRevision: command.expectedRevision,
      revision: command.revision,
      issuedByParticipantId: command.issuedByParticipantId,
      target: { ...command.target },
      body: command.body,
    };
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
    roomStatus: RoomSongStatus,
  ) {
    const videoId = typeof payload.videoId === 'string' ? payload.videoId : null;
    const currentTime = Number(payload.currentTime);
    const state = Number(payload.state);
    const rate = Number(payload.playbackRate ?? 1);
    const roomVideoId = typeof roomStatus.videoId === 'string' ? roomStatus.videoId : null;

    if (command.body.action === 'load') {
      return videoId === command.body.videoId
        && Number.isFinite(currentTime)
        && Math.abs(currentTime - command.body.positionSeconds) <= COMMAND_POSITION_TOLERANCE_SECONDS
        && [-1, 1, 2, 5].includes(state);
    }
    if (command.body.action === 'play') {
      return videoId === roomVideoId && state === 1;
    }
    if (command.body.action === 'pause') {
      return videoId === roomVideoId && state === 2;
    }
    if (command.body.action === 'seek') {
      return videoId === roomVideoId
        && Number.isFinite(currentTime)
        && Math.abs(currentTime - command.body.positionSeconds) <= COMMAND_POSITION_TOLERANCE_SECONDS;
    }
    return videoId === roomVideoId
      && Number.isFinite(rate)
      && Math.abs(rate - command.body.playbackRate) <= 0.0001;
  }
}
