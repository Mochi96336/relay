import type { RoomSongCommandBody, RoomSongCommandRequest } from './room-song-command.js';
import { SERVER_INCARNATION } from './server-incarnation.js';
import { LEGACY_PLAYBACK_PARTICIPANT_ID, type PlaybackIdentity } from './song-session.js';

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

function statusHandoffTarget(status: RoomSongStatus): PlaybackIdentity | null {
  const participantId = normalizeParticipantId(status.handoffTargetParticipantId);
  const transportId = typeof status.handoffTargetPlaybackTransportId === 'string'
    ? status.handoffTargetPlaybackTransportId
    : '';
  const generation = Number(status.handoffTargetPlaybackGeneration);
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
    if (identity.participantId === LEGACY_PLAYBACK_PARTICIPANT_ID) return { ok: true };

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

    // A commit is its own authorization, and it outlives the command that
    // started it.
    //
    // Commands expire after COMMAND_TIMEOUT_MS; a handoff has no such bound.
    // The report that completes a commit is the target loading the song and
    // saying where it landed, which on a phone means cueing a video and
    // buffering it - routinely longer than the command lives. Once the command
    // expired, this gate could no longer see that a handoff was in flight, so
    // it read the report it had been waiting for as an unauthorized mutation
    // and refused it. Nothing then completed the handoff, the room stayed in
    // `committing` forever, and every later song load was refused behind it.
    //
    // The target is not a stranger here: the server named it while applying a
    // command that already passed the mic-owner and leader checks, and it is
    // the only identity this state will accept.
    if (
      roomStatus.handoffState === 'committing'
      && sameIdentity(statusHandoffTarget(roomStatus), identity)
    ) {
      return { ok: true };
    }

    // A leader whose own clock went stale re-anchors it rather than being
    // locked out of it.
    //
    // The two sides judge a mutation against different baselines. The player
    // compares a snapshot against its own previous one, so a gap it sat
    // through - a long rebuffer, a backgrounded tab, a network hole - reads as
    // "nothing changed" locally and never raises a command. The room compares
    // that same snapshot against a clock that kept running without it, sees a
    // jump, and refuses it. But a refused report never reaches the timeline,
    // so it cannot correct the very drift it is being refused for. The
    // refusals then repeat at the telemetry rate and this player can never
    // drive the room again without reloading the page.
    //
    // Only the established leader gets this, and only once its own reports
    // have gone stale. Its reports are what the room clock is made of, so
    // there is nothing here to take from anyone else. A player that is not
    // leading still needs an accepted command to put a song in the room:
    // reporting telemetry at an idle room must never become a second,
    // unauthorized way to set one.
    //
    // Tested for `false` rather than "not true": a status that never carried
    // the field at all is not evidence of staleness, and must not open the
    // gate by omission.
    if (roomStatus.connected === false && sameIdentity(statusLeader(roomStatus), identity)) {
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

    // Compared against where the player's *own last accepted report* would be
    // by now, not against `serverTime`.
    //
    // `serverTime` is where the room clock predicts the player should be, and
    // a player that rebuffers falls behind that prediction without anybody
    // seeking. Judging against it made every packet after a stall longer than
    // the threshold look like an unrequested seek, so all of them were refused
    // — and because a refused packet never reaches the timeline, it could never
    // re-anchor. A two second stall left the room clock permanently two
    // seconds ahead of the audio, silently, and growing.
    //
    // The honest bound is that a player can only fall behind its own last
    // report by the time that has actually passed. Anything beyond that in
    // either direction is a real jump.
    const reportedTime = Number(roomStatus.youtubeTime);
    const incomingTime = Number(payload.currentTime);
    const elapsedSeconds = Math.max(0, Number(roomStatus.ageMs) || 0) / 1000;
    if (Number.isFinite(reportedTime) && Number.isFinite(incomingTime)) {
      const delta = incomingTime - reportedTime;
      if (delta > SEEK_MUTATION_THRESHOLD_SECONDS) return 'seek';
      if (delta < -(elapsedSeconds + SEEK_MUTATION_THRESHOLD_SECONDS)) return 'seek';
    }

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
