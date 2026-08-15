import { performance } from 'node:perf_hooks';

import { YouTubeTimelineTracker } from './youtube-timeline.js';

const LEADER_STALE_AFTER_MS = 1_500;

export type PlaybackIdentity = {
  participantId: string;
  transportId: string;
  generation: number;
};

export type SongTelemetryResult = {
  accepted: boolean;
  reason?: 'invalid-identity' | 'invalid-telemetry' | 'mic-owner-required' | 'leader-busy';
  leaderChanged: boolean;
};

type Leader = PlaybackIdentity & {
  connected: boolean;
  lastTelemetryAtMs: number;
};

export function normalizePlaybackTransportId(value: unknown) {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(id) ? id : null;
}

export function normalizePlaybackGeneration(value: unknown) {
  const generation = Number(value);
  return Number.isInteger(generation) && generation >= 0 && generation <= 0xffff_ffff
    ? generation >>> 0
    : null;
}

/**
 * Room-owned song state and the authority boundary in front of media-clock
 * measurement.
 *
 * YouTubeTimelineTracker deliberately remains ignorant of people and sockets:
 * it measures one accepted media clock. SongSession decides which playback
 * transport is allowed to feed that clock.
 *
 * This is intentionally not a visible DJ role. With no microphone owner, the
 * first healthy playback transport keeps the room clock until it disconnects
 * or goes stale. Once a microphone owner exists, telemetry from other
 * participants is rejected and the owner may replace the previous leader.
 *
 * Multiple tabs belonging to one participant do not last-writer-win against
 * each other. A healthy leader remains authoritative; only a newer generation
 * of the same transport, or an unavailable leader, may replace it. The later
 * song-handoff layer can explicitly coordinate which tab should become leader
 * when microphone ownership moves.
 */
export class SongSession {
  private readonly timeline = new YouTubeTimelineTracker();
  private leader: Leader | null = null;
  private revisionValue = 0;

  get revision() {
    return this.revisionValue;
  }

  get hasTelemetry() {
    return this.timeline.hasTelemetry;
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

    const authority = this.canWrite(identity, micOwnerId, nowMs);
    if (!authority.ok) {
      return { accepted: false, reason: authority.reason, leaderChanged: false };
    }

    // Validate the media payload before granting authority. A malformed packet
    // must never be able to steal the room clock merely by arriving first.
    const before = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    if (!this.timeline.update(payload, nowMs)) {
      return { accepted: false, reason: 'invalid-telemetry', leaderChanged: false };
    }

    const leaderChanged = !this.sameIdentity(this.leader, identity);
    if (leaderChanged) {
      this.leader = {
        ...identity,
        connected: true,
        lastTelemetryAtMs: nowMs,
      };
      this.bump();
    } else if (this.leader) {
      this.leader.connected = true;
      this.leader.lastTelemetryAtMs = nowMs;
    }

    const after = this.timeline.statusPayload(nowMs) as Record<string, unknown>;
    if (!leaderChanged && this.semanticTimelineChanged(before, after)) this.bump();

    return { accepted: true, leaderChanged };
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
    };
  }

  private canWrite(identity: PlaybackIdentity, micOwnerId: string | null, nowMs: number): {
    ok: true;
  } | {
    ok: false;
    reason: 'mic-owner-required' | 'leader-busy';
  } {
    if (micOwnerId !== null && identity.participantId !== micOwnerId) {
      return { ok: false, reason: 'mic-owner-required' };
    }

    if (!this.leader) return { ok: true };
    if (this.sameIdentity(this.leader, identity)) return { ok: true };

    // A new microphone owner supersedes the previous participant's playback
    // authority. 0C will later make this a prepared song handoff; for 0A the
    // important property is that the old phone can no longer mutate the clock.
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
