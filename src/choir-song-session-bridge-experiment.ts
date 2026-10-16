import type { SongSession } from './song-session.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import type { ChoirDeadlineRoomExperiment } from './choir-deadline-room-experiment.js';

/**
 * OFFLINE ONLY: adapt the server-owned, admission-gated SongSession timeline
 * to one experimental Choir room. No client-declared epoch or time mapping
 * reaches this adapter. Calling code still owns admission and Robot PCM route.
 *
 * PlaybackIdentity.generation is NOT backing PCM capture generation:
 * they are different clock domains and must never be compared or substituted.
 */
export class ChoirSongSessionBridgeExperiment {
  private accepted: {
    revision: number;
    videoId: string;
    playbackParticipantId: string;
    playbackTransportId: string;
    playbackGeneration: number;
    robotSourceGeneration: number;
    playbackRate: number;
    corrections: number;
    phaseCorrections: number;
    lastNowMs: number;
    lastProjectedSeconds: number;
  } | null = null;
  private invalidated = false;

  constructor(
    private readonly songs: Pick<SongSession, 'statusPayload'>,
    private readonly room: Pick<
      ChoirDeadlineRoomExperiment,
      'setTrustedPlaybackMapping' | 'invalidateTrustedPlaybackAuthority'
    >,
    private readonly robot: Pick<SourceRuntime<SourceRuntimeSocket>, 'connected' | 'generation'>,
    private readonly scope: {
      videoId: string;
      songEpoch: number;
      backingGeneration: number;
    },
  ) {}

  /** Call on accepted server SongSession telemetry and before each Choir tick. */
  sync(nowMs: number): 'awaiting-playback' | 'initialized' | 'stable' | 'invalidated' {
    if (this.invalidated) return 'invalidated';
    if (!Number.isFinite(nowMs)) return this.fail(nowMs);
    const state = this.songs.statusPayload(nowMs) as Record<string, unknown>;
    const revision = state.revision;
    const playbackGeneration = state.playbackGeneration;
    const videoId = state.videoId;
    const rate = state.playbackRate;
    const corrections = state.corrections;
    const phaseCorrections = state.phaseCorrections ?? 0;
    const projected = state.serverTime;
    const participantId = state.playbackLeaderParticipantId;
    const transportId = state.playbackTransportId;
    const robotGeneration = this.robot.generation;
    const valid = this.robot.connected()
      && Number.isSafeInteger(robotGeneration) && robotGeneration >= 0
      && state.connected === true
      && state.leaderConnected === true && state.leaderFresh === true
      && state.handoffState === 'idle' && state.state === 1
      && videoId === this.scope.videoId
      && typeof participantId === 'string' && participantId.length > 0
      && typeof transportId === 'string' && transportId.length > 0
      && Number.isSafeInteger(revision) && (revision as number) >= 1
      && Number.isSafeInteger(playbackGeneration) && (playbackGeneration as number) >= 0
      && typeof rate === 'number' && Number.isFinite(rate) && rate >= .25 && rate <= 4
      && Number.isSafeInteger(corrections) && (corrections as number) >= 0
      && Number.isSafeInteger(phaseCorrections) && (phaseCorrections as number) >= 0
      && typeof projected === 'number' && Number.isFinite(projected)
      && projected >= 0;
    if (!valid) {
      if (this.accepted === null) return 'awaiting-playback';
      return this.fail(nowMs);
    }
    const next = {
      revision: revision as number,
      videoId: videoId as string,
      playbackParticipantId: participantId as string,
      playbackTransportId: transportId as string,
      playbackGeneration: playbackGeneration as number,
      robotSourceGeneration: robotGeneration,
      playbackRate: rate as number,
      corrections: corrections as number,
      phaseCorrections: phaseCorrections as number,
      lastNowMs: nowMs,
      lastProjectedSeconds: projected as number,
    };
    if (this.accepted !== null) {
      const last = this.accepted;
      const elapsedMs = nowMs - last.lastNowMs;
      const expectedSeconds = last.lastProjectedSeconds
        + elapsedMs * last.playbackRate / 1_000;
      const phaseDelta = next.phaseCorrections - last.phaseCorrections;
      const projectionDelta = Math.abs(next.lastProjectedSeconds - expectedSeconds);
      // SongSession's confirmed sub-second phase drift is a clock refinement,
      // not a seek. It increments both correction and revision counters; using
      // either counter alone retired B on every ordinary clock adjustment.
      const softPhaseCorrection = phaseDelta > 0
        && next.corrections - last.corrections === phaseDelta
        && next.revision - last.revision === phaseDelta
        && projectionDelta <= .75;
      const discontinuity = projectionDelta > .4 && !softPhaseCorrection;
      if (elapsedMs < 0 || (next.revision !== last.revision && !softPhaseCorrection)
        || next.videoId !== last.videoId
        || next.playbackParticipantId !== last.playbackParticipantId
        || next.playbackTransportId !== last.playbackTransportId
        || next.playbackGeneration !== last.playbackGeneration
        || next.robotSourceGeneration !== last.robotSourceGeneration
        || Math.abs(next.playbackRate - last.playbackRate) > 0.0001
        || (next.corrections !== last.corrections && !softPhaseCorrection) || discontinuity) {
        return this.fail(nowMs);
      }
      this.accepted = next;
      return 'stable';
    }

    // SongSession revision is generated by the authenticated server-side
    // playback authority, not the client. SourceRuntime generation protects
    // the Robot CONTROL source; Robot PCM backingGeneration separately binds
    // the canonical capture clock. None of these numbers is interchangeable.
    const created = this.room.setTrustedPlaybackMapping({
      mappingEpoch: next.revision,
      videoId: this.scope.videoId,
      songEpoch: this.scope.songEpoch,
      backingGeneration: this.scope.backingGeneration,
      robotCaptureGeneration: this.scope.backingGeneration,
      playbackRate: next.playbackRate,
      playing: true,
    }, nowMs);
    if (!created) return this.fail(nowMs);
    this.accepted = next;
    return 'initialized';
  }

  private fail(nowMs: number): 'invalidated' {
    if (this.accepted !== null) this.room.invalidateTrustedPlaybackAuthority(nowMs);
    this.invalidated = true;
    return 'invalidated';
  }
}
