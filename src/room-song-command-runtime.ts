import type { RoomSongCommandRequest } from './room-song-command.js';
import {
  RoomSongCommandSession,
  type RoomSongCommandDecision,
  type RoomSongTelemetryGate,
} from './room-song-command-session.js';
import type { PlaybackIdentity } from './song-session.js';

type RoomSongStatus = Record<string, unknown>;

/**
 * Owns the room-song command transaction epoch around RoomSongCommandSession.
 *
 * RoomSongCommandSession remains the intent-ordering and semantic-proof owner.
 * SongSession remains playback-leader/media-clock authority. Socket routing,
 * broadcasts, Mic ownership and room projection stay in server orchestration.
 */
export class RoomSongCommandRuntime {
  private readonly session = new RoomSongCommandSession();
  private revisionValue = 0;

  get revision() {
    return this.revisionValue;
  }

  begin(
    request: RoomSongCommandRequest,
    actorParticipantId: string,
    requesterPlayback: PlaybackIdentity,
    micOwnerId: string | null,
    roomStatus: RoomSongStatus,
    nowMs: number,
  ): RoomSongCommandDecision {
    const decision = this.session.begin(
      request,
      actorParticipantId,
      requesterPlayback,
      micOwnerId,
      roomStatus,
      this.revisionValue,
      this.revisionValue + 1,
      nowMs,
    );
    if (decision.ok && !decision.duplicate) {
      this.revisionValue = decision.command.revision;
    }
    return decision;
  }

  gateTelemetry(
    payload: Record<string, unknown>,
    identity: PlaybackIdentity,
    roomStatus: RoomSongStatus,
    nowMs: number,
  ): RoomSongTelemetryGate {
    return this.session.gateTelemetry(payload, identity, roomStatus, nowMs);
  }

  complete(commandId: string) {
    return this.session.complete(commandId);
  }

  fail(identity: PlaybackIdentity, commandId: unknown) {
    return this.session.fail(identity, commandId);
  }

  cancelPending() {
    return this.session.cancelPending();
  }

  pendingForTarget(identity: PlaybackIdentity, nowMs: number) {
    return this.session.pendingForTarget(identity, nowMs);
  }

  sweep(nowMs: number) {
    return this.session.sweep(nowMs);
  }

  statusPayload(nowMs: number) {
    return this.session.statusPayload(this.revisionValue, nowMs);
  }
}
