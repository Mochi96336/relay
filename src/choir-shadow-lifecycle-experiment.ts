import type { SongSession } from './song-session.js';
import type { SourceRuntime, SourceRuntimeSocket } from './source-runtime.js';
import { ChoirDeadlineRoomExperiment } from './choir-deadline-room-experiment.js';
import { ChoirSongSessionBridgeExperiment } from './choir-song-session-bridge-experiment.js';

type State = 'awaiting-authority' | 'shadow-active' | 'restart-required';

export type ChoirShadowSnapshot = {
  state: State;
  roomEpoch: number | null;
  songEpoch: number | null;
  backingGeneration: number | null;
  videoId: string | null;
};

/**
 * Private opt-in server control-plane witness.
 *
 * Never admits singers, copies live Mic/Robot packets, emits PCM, changes
 * SongSession/SourceRuntime, drives monitoring/recording or exposes any
 * client messages. This is intentionally NOT a public Choir transport.
 *
 * After an authority/clock discontinuity, the instance latches permanently
 * until a future trusted coordinator explicitly authorizes a FRESH room
 * epoch. Merely seeing SongSession PLAYING again is insufficient.
 */
export class ChoirShadowLifecycleExperiment {
  private active: {
    room: ChoirDeadlineRoomExperiment;
    bridge: ChoirSongSessionBridgeExperiment;
    roomEpoch: number;
    songEpoch: number;
    backingGeneration: number;
    videoId: string;
  } | null = null;
  private state: State = 'awaiting-authority';
  private lastRoomEpoch = 0;
  private lastSongEpoch = 0;
  private initialRoomAllowed = true;

  constructor(
    private readonly songs: Pick<SongSession, 'statusPayload'>,
    private readonly robot: Pick<SourceRuntime<SourceRuntimeSocket>, 'connected' | 'generation'>,
    private readonly config: {
      sampleRate: number;
      frameMs: number;
      prebufferMs: number;
      retentionMs: number;
      outputHoldbackMs: number;
      contentHistoryMs: number;
    },
  ) {}

  observe(nowMs: number, backingGeneration: number | null): ChoirShadowSnapshot {
    if (this.state === 'restart-required') return this.snapshot();
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(backingGeneration)
      || backingGeneration === null || backingGeneration < 0) {
      if (this.active) this.retire(nowMs);
      return this.snapshot();
    }
    if (this.active) {
      if (this.active.backingGeneration !== backingGeneration
        || this.active.bridge.sync(nowMs) === 'invalidated')
        this.retire(nowMs);
      return this.snapshot();
    }
    if (!this.initialRoomAllowed) return this.snapshot();
    const status = this.songs.statusPayload(nowMs) as Record<string, unknown>;
    const videoId = typeof status.videoId === 'string' ? status.videoId : null;
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)
      || status.connected !== true || status.leaderConnected !== true
      || status.leaderFresh !== true || status.state !== 1
      || status.handoffState !== 'idle' || !this.robot.connected()) return this.snapshot();
    const songEpoch = this.lastSongEpoch + 1;
    const roomEpoch = this.lastRoomEpoch + 1;
    const room = new ChoirDeadlineRoomExperiment({
      ...this.config,
      videoId, backingGeneration, songEpoch, roomEpochMs: nowMs,
    });
    const bridge = new ChoirSongSessionBridgeExperiment(
      this.songs, room, this.robot, { videoId, songEpoch, backingGeneration },
    );
    if (bridge.sync(nowMs) !== 'initialized') {
      this.state = 'restart-required';
      this.initialRoomAllowed = false;
      return this.snapshot();
    }
    this.lastRoomEpoch = roomEpoch;
    this.lastSongEpoch = songEpoch;
    this.initialRoomAllowed = false;
    this.active = { room, bridge, roomEpoch, songEpoch, backingGeneration, videoId };
    this.state = 'shadow-active';
    return this.snapshot();
  }

  private retire(nowMs: number) {
    this.active?.room.invalidateTrustedPlaybackAuthority(nowMs);
    this.active = null;
    this.state = 'restart-required';
    this.initialRoomAllowed = false;
  }

  /**
   * Private future restart-handshake hook, intentionally NOT wired to any
   * client command or automatic timer. A new server-owned room incarnation
   * and song epoch must be claimed *strictly after* the retired incarnations.
   *
   * Admitting real Mic publishers would require separately verified per-singer
   * fresh Media Epoch / Content evidence, and is out of scope here.
   */
  authorizeExplicitFreshRoom(
    retiredRoomEpoch: number, proposedRoomEpoch: number,
    proposedSongEpoch: number,
  ): boolean {
    if (this.state !== 'restart-required'
      || retiredRoomEpoch !== this.lastRoomEpoch
      || !Number.isSafeInteger(proposedRoomEpoch)
      || proposedRoomEpoch <= this.lastRoomEpoch
      || !Number.isSafeInteger(proposedSongEpoch)
      || proposedSongEpoch <= this.lastSongEpoch) return false;
    this.lastRoomEpoch = proposedRoomEpoch - 1;
    this.lastSongEpoch = proposedSongEpoch - 1;
    this.state = 'awaiting-authority';
    this.initialRoomAllowed = true;
    return true;
  }

  snapshot(): ChoirShadowSnapshot {
    return {
      state: this.state,
      roomEpoch: this.active?.roomEpoch ?? null,
      songEpoch: this.active?.songEpoch ?? null,
      backingGeneration: this.active?.backingGeneration ?? null,
      videoId: this.active?.videoId ?? null,
    };
  }
}
