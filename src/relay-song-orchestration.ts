import type { AcceptedRoomSongCommand } from './room-song-command-session.js';
import type { RoomSongCommandRuntime } from './room-song-command-runtime.js';
import type { PlaybackIdentity, SongHandoffPlan, SongSession } from './song-session.js';
import { createRelayRoomSongCommandAcceptanceCoordinator } from './relay-room-song-command-acceptance-coordinator.js';
import { createRelaySongHandoffResultCoordinator } from './relay-song-handoff-result-coordinator.js';
import { createRelayPlaybackRegistrationContinuationCoordinator } from './relay-playback-registration-continuation-coordinator.js';
import { createRelayYoutubeTelemetryAcceptanceCoordinator,
  type RelayYoutubeTelemetryStatus } from './relay-youtube-telemetry-acceptance-coordinator.js';
import { createRelayPlaybackDisconnectCoordinator } from './relay-playback-disconnect-coordinator.js';

type TelemetrySocket = { telemetryRejectedReason?: string };

export type RelaySongCommandOrchestrationDependencies<TSocket extends TelemetrySocket> = {
  readonly clock: Readonly<{ now(): number }>;
  readonly commands: Readonly<Pick<RoomSongCommandRuntime,
    'revision' | 'cancelPending' | 'sweep' | 'pendingForTarget' | 'fail'>>;
  readonly song: Readonly<{
    roomStatusPayload(nowMs?: number): unknown;
    statusPayload(nowMs?: number): Readonly<{ playbackLeaderParticipantId: unknown }>;
  }>;
  readonly playback: Readonly<{
    send(identity: PlaybackIdentity, payload: unknown): unknown;
  }>;
  readonly participants: Readonly<{ micOwnerId: string | null }>;
  readonly queries: Readonly<{
    participantPayload(participantId: string | null): unknown;
    commandStatusPayload(nowMs: number): unknown;
  }>;
  readonly effects: Readonly<{
    send(socket: TSocket, payload: unknown): void;
    broadcast(payload: unknown): void;
  }>;
};

/** Sequencing only: intent, revisions, proof and playback authority stay in their original owners. */
export function createRelaySongCommandOrchestration<TSocket extends TelemetrySocket>(
  dependencies: RelaySongCommandOrchestrationDependencies<TSocket>,
) {
  const commands = dependencies.commands;
  const song = dependencies.song;
  const playback = dependencies.playback;
  const participants = dependencies.participants;
  const queries = dependencies.queries;
  const effects = dependencies.effects;
  const clock = dependencies.clock;

  function applyPayload(command: AcceptedRoomSongCommand) {
    return {
      type: 'room-song-command-apply',
      commandId: command.commandId,
      revision: command.revision,
      supersedesCommandId: command.supersedesCommandId,
      issuedByParticipantId: command.issuedByParticipantId,
      targetPlaybackTransportId: command.target.transportId,
      targetPlaybackGeneration: command.target.generation,
      ...command.body,
    };
  }

  function reject(socket: TSocket, commandId: unknown, reason: string) {
    effects.send(socket, {
      type: 'room-song-command-rejected',
      commandId: typeof commandId === 'string' ? commandId : null,
      reason,
      revision: commands.revision,
      room: song.roomStatusPayload(),
    });
  }

  function reportFailure(commandId: string, reason: string, nowMs = clock.now()) {
    effects.broadcast({
      type: 'room-song-command-failed-ack',
      commandId,
      revision: commands.revision,
      reason,
      room: song.roomStatusPayload(nowMs),
    });
  }

  function cancelPending(reason: string, nowMs = clock.now()) {
    const cancelled = commands.cancelPending();
    if (!cancelled) return false;
    reportFailure(cancelled.commandId, reason, nowMs);
    effects.broadcast(queries.commandStatusPayload(nowMs));
    return true;
  }

  function stepExpiry(nowMs: number) {
    const expired = commands.sweep(nowMs);
    if (expired) {
      reportFailure(expired.commandId, 'command-timeout', nowMs);
      effects.broadcast(queries.commandStatusPayload(nowMs));
    }
  }

  // Socket identity admission and clock sampling precede this entry in server.
  function failPending(identity: PlaybackIdentity, commandId: unknown, nowMs: number) {
    const pending = commands.pendingForTarget(identity, nowMs);
    if (
      pending
      && commandId === pending.commandId
      && commands.fail(identity, pending.commandId)
    ) {
      reportFailure(pending.commandId, 'playback-failed', nowMs);
      effects.broadcast(queries.commandStatusPayload(nowMs));
    }
  }

  function reportRoomTelemetryRejected(socket: TSocket, reason: string) {
    const key = `room-song:${reason}`;
    if (socket.telemetryRejectedReason === key) return;
    socket.telemetryRejectedReason = key;
    effects.send(socket, {
      type: 'room-song-telemetry-rejected',
      reason,
      revision: commands.revision,
    });
  }

  function reportTelemetryRejected(socket: TSocket, reason: string) {
    if (socket.telemetryRejectedReason === reason) return;
    socket.telemetryRejectedReason = reason;
    effects.send(socket, {
      type: 'youtube-telemetry-rejected',
      reason,
      playbackLeaderParticipantId: song.statusPayload().playbackLeaderParticipantId,
      micOwner: queries.participantPayload(participants.micOwnerId),
    });
  }

  const acceptance = createRelayRoomSongCommandAcceptanceCoordinator<
    TSocket, PlaybackIdentity, AcceptedRoomSongCommand
  >({
    sendAccepted: (socket, commandId, revision, duplicate) => {
      effects.send(socket, { type: 'room-song-command-accepted', commandId, revision, duplicate });
    },
    pendingForTarget: (target, nowMs) => commands.pendingForTarget(target, nowMs),
    sendApply: (target, command) => playback.send(target, applyPayload(command)),
    reportStatus: (nowMs) => effects.broadcast(queries.commandStatusPayload(nowMs)),
  });

  return { applyPayload, reject, reportFailure, cancelPending, stepExpiry, failPending,
    reportRoomTelemetryRejected, reportTelemetryRejected, accept: acceptance.accept };
}

export type RelaySongLifecycleDependencies<TSocket extends TelemetrySocket> = {
  readonly clock: Readonly<{ now(): number }>;
  readonly participants: Readonly<{ micOwnerId: string | null }>;
  readonly song: Readonly<Pick<SongSession, 'beginHandoff' | 'handoffTarget' | 'sweepHandoff'
    | 'markHandoffReady' | 'deferHandoff' | 'handoffPlanForTarget' | 'detach'>> & Readonly<{
      statusPayload(nowMs?: number): unknown;
      roomStatusPayload(nowMs?: number): unknown;
    }>;
  readonly playback: Readonly<{
    selectHandoffTarget(participantId: string, nowMs: number): PlaybackIdentity | null;
    connected(identity: PlaybackIdentity): boolean;
    identity(socket: TSocket): PlaybackIdentity | null;
    register(socket: TSocket, identity: PlaybackIdentity): unknown;
    send(identity: PlaybackIdentity, payload: unknown): number;
  }>;
  readonly commands: Readonly<Pick<RoomSongCommandRuntime, 'revision' | 'pendingForTarget' | 'complete' | 'fail'>>;
  readonly commandOrchestration: Readonly<Pick<ReturnType<typeof createRelaySongCommandOrchestration<TSocket>>,
    'applyPayload' | 'reportFailure'>>;
  readonly queries: Readonly<{ commandStatusPayload(nowMs?: number): unknown }>;
  readonly crossCommands: Readonly<{
    cancelActiveContentValidation(nowMs: number): boolean;
    revokeContentMappingOnRateChange(playbackRate: unknown): boolean;
  }>;
  readonly effects: Readonly<{
    send(socket: TSocket, payload: unknown): void;
    broadcast(payload: unknown): void;
    reportTimingStatus(): void;
    reportAcceptedTimelineStatus(status: RelayYoutubeTelemetryStatus): void;
  }>;
};

/** Application effects only. Song, command and transport owners decide every identity and proof. */
export function createRelaySongLifecycle<TSocket extends TelemetrySocket>(
  dependencies: RelaySongLifecycleDependencies<TSocket>,
) {
  const song = dependencies.song;
  const playback = dependencies.playback;
  const commands = dependencies.commands;
  const commandOrchestration = dependencies.commandOrchestration;
  const participants = dependencies.participants;
  const clock = dependencies.clock;
  const queries = dependencies.queries;
  const effects = dependencies.effects;
  const crossCommands = dependencies.crossCommands;

  function handoffPayload(type: 'song-handoff-prepare' | 'song-handoff-commit', plan: SongHandoffPlan) {
    return { type, handoffId: plan.handoffId, revision: plan.revision, videoId: plan.videoId,
      state: plan.state, serverTime: plan.serverTime, playbackRate: plan.playbackRate };
  }

  function sendHandoffPlan(type: 'song-handoff-prepare' | 'song-handoff-commit', plan: SongHandoffPlan) {
    return playback.send(plan.target, handoffPayload(type, plan));
  }

  function prepare(participantId: string, nowMs = clock.now()) {
    const target = playback.selectHandoffTarget(participantId, nowMs);
    if (!target) return false;
    const plan = song.beginHandoff(target, participants.micOwnerId, nowMs);
    if (!plan) return false;
    sendHandoffPlan('song-handoff-prepare', plan);
    effects.broadcast(song.statusPayload(nowMs));
    effects.broadcast(song.roomStatusPayload(nowMs));
    return true;
  }

  function stepHandoff(nowMs: number) {
    const target = song.handoffTarget();
    if (!target) return false;
    if (!song.sweepHandoff(playback.connected(target), nowMs, participants.micOwnerId)) return false;
    playback.send(target, { type: 'song-handoff-cancelled' });
    effects.broadcast(song.statusPayload(nowMs));
    effects.broadcast(song.roomStatusPayload(nowMs));
    return true;
  }

  const handoffResult = createRelaySongHandoffResultCoordinator<PlaybackIdentity, SongHandoffPlan>({
    markReady: (identity, handoffId, micOwnerId) => song.markHandoffReady(identity, handoffId, micOwnerId),
    defer: (identity, handoffId) => song.deferHandoff(identity, handoffId),
    sendCommit: (plan) => { sendHandoffPlan('song-handoff-commit', plan); },
    reportTimelineStatus: () => effects.broadcast(song.statusPayload()),
    reportRoomStatus: () => effects.broadcast(song.roomStatusPayload()),
  });

  const registration = createRelayPlaybackRegistrationContinuationCoordinator<
    TSocket, PlaybackIdentity, SongHandoffPlan, AcceptedRoomSongCommand
  >({
    sendRegistered: (socket, identity) => {
      effects.send(socket, { type: 'playback-registered', playbackTransportId: identity.transportId,
        playbackGeneration: identity.generation });
    },
    sendRoomStatus: (socket) => effects.send(socket, song.roomStatusPayload()),
    sendCommandStatus: (socket) => effects.send(socket, queries.commandStatusPayload()),
    handoffPlanForTarget: (identity) => song.handoffPlanForTarget(identity),
    sendHandoffPrepare: (plan) => { sendHandoffPlan('song-handoff-prepare', plan); },
    now: () => clock.now(),
    pendingCommandForTarget: (identity, nowMs) => commands.pendingForTarget(identity, nowMs),
    sendCommandApply: (identity, command) => playback.send(identity, commandOrchestration.applyPayload(command)),
  });

  const telemetry = createRelayYoutubeTelemetryAcceptanceCoordinator<TSocket, PlaybackIdentity>({
    registerPlayback: (socket, identity) => { playback.register(socket, identity); },
    clearTelemetryRejection: (socket) => { socket.telemetryRejectedReason = undefined; },
    cancelActiveContentValidation: (nowMs) => crossCommands.cancelActiveContentValidation(nowMs),
    revokeContentMappingOnRateChange: (playbackRate) => crossCommands.revokeContentMappingOnRateChange(playbackRate),
    reportTimingStatus: () => effects.reportTimingStatus(),
    reportTimelineStatus: (status) => effects.reportAcceptedTimelineStatus(status),
    reportRoomStatus: (nowMs) => effects.broadcast(song.roomStatusPayload(nowMs)),
    completeRoomSongCommand: (commandId) => commands.complete(commandId),
    reportRoomSongCommandComplete: (commandId) => {
      effects.broadcast({ type: 'room-song-command-complete', commandId, revision: commands.revision });
    },
    reportRoomSongCommandStatus: (nowMs) => effects.broadcast(queries.commandStatusPayload(nowMs)),
    releasePreviousLeader: (previousLeader, handoffId, videoId) => {
      playback.send(previousLeader, { type: 'song-handoff-release', handoffId, videoId });
    },
    completeHandoff: (identity, handoffId) => { playback.send(identity, { type: 'song-handoff-complete', handoffId }); },
  });

  const disconnect = createRelayPlaybackDisconnectCoordinator<TSocket>({
    identity: (socket) => playback.identity(socket),
    now: () => clock.now(),
    pendingCommand: (identity, nowMs) => commands.pendingForTarget(identity, nowMs),
    failPending: (identity, commandId) => commands.fail(identity, commandId),
    reportCommandFailure: (commandId, nowMs) => {
      commandOrchestration.reportFailure(commandId, 'playback-disconnected', nowMs);
      effects.broadcast(queries.commandStatusPayload(nowMs));
    },
    detachTimeline: (identity) => song.detach(identity),
    reportTimelineChanged: () => {
      effects.broadcast(song.statusPayload());
      effects.broadcast(song.roomStatusPayload());
    },
  });

  return { prepare, stepHandoff, ready: handoffResult.ready, failed: handoffResult.failed,
    continueRegistration: registration.continueRegistration, acceptTelemetry: telemetry.accept, disconnect: disconnect.handle };
}
