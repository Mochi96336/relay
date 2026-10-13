/**
 * Non-authoritative YouTube follower policy for an eventual singer's local
 * player. No network messages or SongSession mutations live here.
 *
 * The caller must supply room.positionSeconds as ALREADY projected to the
 * local observation instant. This policy cannot synchronize arbitrary server
 * and browser clocks and must never broadcast follower currentTime as room
 * authority.
 */
export type ChoirPlaybackState = 'playing' | 'paused' | 'buffering' | 'cued';
export type ChoirFollowerRoom = {
  videoId: string;
  songEpoch: number;
  positionSeconds: number;
  playbackRate: number;
  state: 'playing' | 'paused';
};
export type ChoirFollowerLocal = {
  videoId: string | null;
  positionSeconds: number;
  playbackRate: number;
  state: ChoirPlaybackState;
  userGestureReady: boolean;
};
export type ChoirFollowerAction =
  | { action: 'none'; reason: string; signedDriftMs: number | null }
  | { action: 'load'; videoId: string; positionSeconds: number; songEpoch: number }
  | { action: 'seek'; positionSeconds: number; signedDriftMs: number }
  | { action: 'play'; requiresUserGesture: boolean }
  | { action: 'pause' }
  | { action: 'rate'; playbackRate: number };

export class ChoirFollowerPolicy {
  private lastSeekMs = Number.NEGATIVE_INFINITY;
  private activeEpoch: number | null = null;

  constructor(
    private readonly seekThresholdMs = 450,
    private readonly minSeekIntervalMs = 3_000,
  ) {
    if (!(seekThresholdMs > 0) || !(minSeekIntervalMs > 0)) {
      throw new RangeError('Invalid Choir follower thresholds');
    }
  }

  decide(input: {
    room: ChoirFollowerRoom;
    local: ChoirFollowerLocal;
    nowMs: number;
    roomFresh: boolean;
  }): ChoirFollowerAction {
    const { room, local, nowMs } = input;
    if (!input.roomFresh || !Number.isFinite(nowMs)
      || !/^[A-Za-z0-9_-]{11}$/.test(room.videoId)
      || !Number.isSafeInteger(room.songEpoch) || room.songEpoch < 0
      || !Number.isFinite(room.positionSeconds) || room.positionSeconds < 0
      || !Number.isFinite(local.positionSeconds) || local.positionSeconds < 0
      || !Number.isFinite(room.playbackRate) || room.playbackRate <= 0) {
      return { action: 'none', reason: 'room-not-authoritative', signedDriftMs: null };
    }

    if (this.activeEpoch !== room.songEpoch) {
      this.activeEpoch = room.songEpoch;
      this.lastSeekMs = Number.NEGATIVE_INFINITY;
    }

    if (local.videoId !== room.videoId) {
      return {
        action: 'load', videoId: room.videoId,
        positionSeconds: room.positionSeconds, songEpoch: room.songEpoch,
      };
    }

    if (room.state === 'paused') {
      if (local.state === 'playing') return { action: 'pause' };
      // A can Seek while paused. Queue a local Seek instead of starting a
      // follower from the previous verse on the next Play command.
      const pausedDriftMs = (local.positionSeconds - room.positionSeconds) * 1000;
      if (local.userGestureReady && Math.abs(pausedDriftMs) >= this.seekThresholdMs
        && nowMs - this.lastSeekMs >= this.minSeekIntervalMs) {
        this.lastSeekMs = nowMs;
        return { action: 'seek', positionSeconds: room.positionSeconds,
          signedDriftMs: pausedDriftMs };
      }
      return { action: 'none', reason: 'paused', signedDriftMs: pausedDriftMs };
    }

    if (!local.userGestureReady) {
      return { action: 'play', requiresUserGesture: true };
    }

    if (local.state === 'buffering') {
      return { action: 'none', reason: 'local-buffering', signedDriftMs: null };
    }

    if (local.state !== 'playing') {
      return { action: 'play', requiresUserGesture: false };
    }

    const signedDriftMs = (local.positionSeconds - room.positionSeconds) * 1000;
    // Frequency correction is intentionally not used for drift control:
    // singer headphones must not hear a constantly wobbling playback rate.
    if (Math.abs(local.playbackRate - room.playbackRate) > .01) {
      return { action: 'rate', playbackRate: room.playbackRate };
    }

    if (Math.abs(signedDriftMs) < this.seekThresholdMs) {
      return { action: 'none', reason: 'within-tolerance', signedDriftMs };
    }

    if (nowMs - this.lastSeekMs < this.minSeekIntervalMs) {
      return { action: 'none', reason: 'seek-cooldown', signedDriftMs };
    }

    this.lastSeekMs = nowMs;
    return { action: 'seek', positionSeconds: room.positionSeconds, signedDriftMs };
  }
}
