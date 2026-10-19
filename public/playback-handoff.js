import { handoffPreparationPosition } from './playback-handoff-timing.js';

// Server proof expires after 5 s; this later watchdog only contains local damage.
export const HANDOFF_COMMIT_TIMEOUT_MS = 6_500;
const REALIGN_THRESHOLD_SECONDS = 0.75;
const READY_CHECK_DELAYS_MS = [80, 220, 500, 900, 1_500, 2_400, 4_000, 7_000, 11_000, 16_000];

/**
 * @typedef {{
 *   getVideoData(): {video_id?: unknown} | null,
 *   getPlayerState(): unknown,
 *   getCurrentTime(): unknown,
 *   getVideoLoadedFraction(): unknown,
 *   isMuted(): boolean,
 *   mute(): void,
 *   unMute(): void,
 *   loadVideoById(input: {videoId: string, startSeconds: number}): void,
 *   seekTo(position: number, allowSeekAhead: boolean): void,
 *   setPlaybackRate(rate: number): void,
 *   playVideo(): void,
 *   pauseVideo(): void,
 * }} HandoffPlayer
 * @typedef {{handoffId: string, videoId: string, targetTime: number, desiredState: number, playbackRate: number}} HandoffPlan
 * @typedef {HandoffPlan & {phase: 'preparing' | 'committing'}} HandoffState
 * @typedef {{timers: number[]}} SampleJob
 * @typedef {HandoffState & {
 *   reusePreparedPlayer: boolean, readySent: boolean, timerEpoch: number,
 *   timers: Set<number>, samples: SampleJob | null,
 * }} Attempt
 * @typedef {{
 *   source: 'handoff-prepare' | 'handoff-commit', action: 'load' | 'play' | 'pause',
 *   suppressTelemetry: boolean, expiresAt: number,
 * }} HandoffMutation
 * @typedef {{
 *   getPlayer: () => HandoffPlayer | null,
 *   ensurePlayer: (videoId: string, isCurrent: () => boolean) => Promise<unknown>,
 *   onMutation: (mutation: HandoffMutation) => void,
 *   onTimelineBoundary: (videoId: string | null) => void,
 *   onNote: (key: string) => void,
 *   onReady: (handoffId: string) => void,
 *   onFailure: (handoffId: string, reason: string) => void,
 *   sampleNow: () => void,
 *   now?: () => number,
 *   setTimer?: (callback: () => void, delayMs: number) => number,
 *   clearTimer?: (timer: number) => void,
 *   warn?: (message: string, error: unknown) => void,
 * }} HandoffPorts
 */

/**
 * Owns one target-side playback handoff, its mute provenance and delayed work.
 * Preparation and commit remain inaudible. Only explicit server completion may
 * restore the player's original audibility. Every continuation is attempt-scoped.
 */
export class PlaybackHandoff {
  /** @type {Attempt | null} */
  #attempt = null;
  #epoch = 0;
  /** @type {{player: HandoffPlayer, wasMuted: boolean} | null} */
  #muteLease = null;
  /** @type {Required<HandoffPorts>} */
  #ports;

  /** @param {HandoffPorts} ports */
  constructor(ports) {
    this.#ports = {
      ...ports,
      now: ports.now ?? (() => performance.now()),
      setTimer: ports.setTimer ?? globalThis.setTimeout.bind(globalThis),
      clearTimer: ports.clearTimer ?? globalThis.clearTimeout.bind(globalThis),
      warn: ports.warn ?? ((message, error) => console.warn(message, error)),
    };
  }

  /** @returns {Readonly<HandoffState> | null} */
  get pending() {
    if (!this.#attempt) return null;
    const { handoffId, videoId, targetTime, desiredState, playbackRate, phase } = this.#attempt;
    return { handoffId, videoId, targetTime, desiredState, playbackRate, phase };
  }

  /** @param {Attempt} attempt @param {HandoffPlayer | null} [player] */
  #current(attempt, player) {
    return this.#attempt === attempt && (player === undefined || this.#ports.getPlayer() === player);
  }

  /** @param {Attempt} attempt */
  #clearTimers(attempt) {
    attempt.timerEpoch += 1;
    attempt.samples = null;
    for (const timer of attempt.timers) this.#ports.clearTimer(timer);
    attempt.timers.clear();
  }

  /** @param {Attempt} attempt @param {number} delayMs @param {() => void} operation */
  #later(attempt, delayMs, operation) {
    const epoch = attempt.timerEpoch;
    const timer = this.#ports.setTimer(() => {
      attempt.timers.delete(timer);
      if (this.#current(attempt) && attempt.timerEpoch === epoch) operation();
    }, delayMs);
    attempt.timers.add(timer);
    return timer;
  }

  /** @param {HandoffPlayer} player */
  #videoId(player) {
    try {
      const value = player.getVideoData()?.video_id;
      return typeof value === 'string' && value ? value : null;
    } catch { return null; }
  }

  /** Capture provenance before the first effect on this physical player.
   * @param {HandoffPlayer} player */
  #acquireMuteLease(player) {
    if (this.#muteLease?.player !== player) {
      this.#muteLease = { player, wasMuted: Boolean(player.isMuted()) };
    }
  }

  /** @param {HandoffPlan} plan @param {{reusePreparedPlayer?: boolean, wasMuted?: boolean | null}} [preparation] */
  async prepare(plan, { reusePreparedPlayer = false, wasMuted = null } = {}) {
    const previous = this.#attempt;
    const player = this.#ports.getPlayer();
    if (previous) {
      this.#clearTimers(previous);
    }
    // The lease survives replacing a preparation, including synchronous player
    // callbacks during retirement. Relay's own mute is never a new preference.
    if (this.#muteLease?.player !== player) this.#muteLease = null;
    if (!this.#muteLease && player && wasMuted !== null) this.#muteLease = { player, wasMuted };
    this.#epoch += 1;
    /** @type {Attempt} */
    const attempt = { ...plan, phase: 'preparing', reusePreparedPlayer,
      readySent: false, timerEpoch: 0, timers: new Set(), samples: null };
    this.#attempt = attempt;
    this.#ports.onNote('song.preparingHandoff');
    try {
      await this.#ports.ensurePlayer(plan.videoId, () => this.#current(attempt));
      if (!this.#current(attempt) || attempt.phase !== 'preparing') return false;
      this.cue();
      return true;
    } catch (error) {
      if (!this.#current(attempt)) return false;
      this.#ports.warn('Could not initialize room song handoff', error);
      this.#ports.onFailure(attempt.handoffId, 'player-unavailable');
      return false;
    }
  }

  cue() {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    if (!attempt || attempt.phase !== 'preparing' || !player) return false;
    try {
      this.#ports.onMutation({ source: 'handoff-prepare', action: 'load',
        suppressTelemetry: true, expiresAt: this.#ports.now() + 3_000 });
      this.#ports.onTimelineBoundary(attempt.videoId);
      this.#acquireMuteLease(player);
      if (!this.#current(attempt, player)) return false;
      player.mute();
      if (!this.#current(attempt, player)) return false;
      const position = handoffPreparationPosition(attempt.targetTime, attempt.desiredState);
      if (attempt.reusePreparedPlayer && this.#videoId(player) === attempt.videoId) {
        const currentTime = Number(player.getCurrentTime());
        const state = Number(player.getPlayerState());
        if (!Number.isFinite(currentTime) || Math.abs(currentTime - position) > 0.75
            || (state === 0 && position < attempt.targetTime)) player.seekTo(position, true);
      } else {
        // A muted load requests real media; CUED alone proves only a thumbnail.
        player.loadVideoById({ videoId: attempt.videoId, startSeconds: position });
      }
      if (!this.#current(attempt, player)) return false;
      try { player.setPlaybackRate(attempt.playbackRate); } catch {}
      if (!this.#current(attempt, player)) return false;
      this.#clearTimers(attempt);
      for (const delay of READY_CHECK_DELAYS_MS) this.#later(attempt, delay, () => this.announceReady());
      return true;
    } catch (error) {
      if (this.#current(attempt)) {
        this.#ports.warn('Could not prepare room song handoff', error);
        this.#ports.onFailure(attempt.handoffId, 'prepare-failed');
      }
      return false;
    }
  }

  announceReady() {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    if (!attempt || attempt.phase !== 'preparing' || attempt.readySent || !player
        || this.#muteLease?.player !== player || this.#videoId(player) !== attempt.videoId) return false;
    try {
      const state = Number(player.getPlayerState());
      const buffered = Number(player.getVideoLoadedFraction());
      const playing = attempt.desiredState === 1 || attempt.desiredState === 3;
      if (!player.isMuted()) return false;
      if ((playing ? state !== 1 : state !== 2) || !Number.isFinite(buffered) || buffered <= 0) return false;
    } catch { return false; }
    if (!this.#current(attempt, player)) return false;
    attempt.readySent = true;
    this.#clearTimers(attempt);
    this.#ports.onNote('song.handoffPrepared');
    this.#ports.onReady(attempt.handoffId);
    return true;
  }

  /** @param {number} state */
  observeState(state) {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    if (!attempt || attempt.phase !== 'preparing' || !player) return;
    try { player.setPlaybackRate(attempt.playbackRate); } catch {}
    if (!this.#current(attempt, player)) return;
    if (attempt.desiredState !== 1 && state === 1) {
      try { player.pauseVideo(); } catch {}
    }
    if (this.#current(attempt, player)) this.announceReady();
  }

  /** @param {{handoffId?: unknown, serverTime?: unknown, state?: unknown}} message */
  commit(message) {
    const attempt = this.#attempt;
    if (!attempt || message.handoffId !== attempt.handoffId) return false;
    const player = this.#ports.getPlayer();
    if (!player) {
      this.#ports.onFailure(attempt.handoffId, 'player-not-ready');
      return false;
    }
    const targetTime = Number(message.serverTime);
    if (!Number.isFinite(targetTime)) return false;
    this.#clearTimers(attempt);
    attempt.phase = 'committing';
    attempt.targetTime = Math.max(0, targetTime);
    attempt.desiredState = Number(message.state);
    this.#ports.onTimelineBoundary(null);
    this.#ports.onMutation({ source: 'handoff-commit', action: attempt.desiredState === 1 ? 'play' : 'pause',
      suppressTelemetry: false, expiresAt: this.#ports.now() + 2_500 });
    try {
      this.#acquireMuteLease(player);
      player.mute();
      if (!this.#current(attempt, player)) return false;
      if (this.#videoId(player) !== attempt.videoId) {
        player.loadVideoById({ videoId: attempt.videoId, startSeconds: attempt.targetTime });
      }
      if (!this.#current(attempt, player)) return false;
      const currentTime = Number(player.getCurrentTime());
      if (!Number.isFinite(currentTime) || Math.abs(currentTime - attempt.targetTime) > 0.75) {
        player.seekTo(attempt.targetTime, true);
      }
      if (!this.#current(attempt, player)) return false;
      if (attempt.desiredState === 1) player.playVideo();
      else player.pauseVideo();
      if (!this.#current(attempt, player)) return false;
      this.#later(attempt, HANDOFF_COMMIT_TIMEOUT_MS, () => {
        if (attempt.phase === 'committing') this.rollback('commit-timeout');
      });
      this.#sampleAfterCommit(attempt);
      this.#ports.onNote('song.switchingHere');
      return true;
    } catch (error) {
      if (this.#current(attempt)) {
        this.#ports.warn('Could not commit room song handoff', error);
        this.rollback('commit-failed');
      }
      return false;
    }
  }

  /** @param {Attempt} attempt */
  #sampleAfterCommit(attempt) {
    // Fresh timelines replace the two pending samples without extending proof's
    // watchdog or allowing a fast update stream to accumulate timers.
    for (const timer of attempt.samples?.timers ?? []) {
      this.#ports.clearTimer(timer);
      attempt.timers.delete(timer);
    }
    /** @type {SampleJob} */
    const samples = { timers: [] };
    attempt.samples = samples;
    for (const delay of [80, 220]) {
      samples.timers.push(this.#later(attempt, delay, () => {
        if (attempt.samples === samples && attempt.phase === 'committing') this.#ports.sampleNow();
      }));
    }
  }

  /** @param {{handoffState?: unknown, handoffId?: unknown, serverTime?: unknown} | null} timeline */
  realign(timeline) {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    if (!attempt || attempt.phase !== 'committing' || !timeline || !player
        || timeline.handoffState !== 'committing' || timeline.handoffId !== attempt.handoffId
        || this.#videoId(player) !== attempt.videoId) return false;
    const target = Number(timeline.serverTime);
    try {
      const currentTime = Number(player.getCurrentTime());
      if (!Number.isFinite(target) || !Number.isFinite(currentTime)
          || Number(player.getPlayerState()) !== (attempt.desiredState === 1 ? 1 : 2)
          || Math.abs(currentTime - target) <= REALIGN_THRESHOLD_SECONDS) return false;
      attempt.targetTime = Math.max(0, target);
      this.#ports.onTimelineBoundary(null);
      player.mute();
      if (!this.#current(attempt, player)) return false;
      player.seekTo(attempt.targetTime, true);
      if (!this.#current(attempt, player)) return false;
      player.setPlaybackRate(attempt.playbackRate);
      if (!this.#current(attempt, player)) return false;
      if (attempt.desiredState === 1) player.playVideo();
      else player.pauseVideo();
      if (!this.#current(attempt, player)) return false;
      this.#sampleAfterCommit(attempt);
      return true;
    } catch (error) {
      if (this.#current(attempt)) this.#ports.warn('Could not realign committed handoff to authoritative room time', error);
      return false;
    }
  }

  /** @param {string} reason */
  rollback(reason) {
    const attempt = this.#attempt;
    if (!attempt || attempt.phase !== 'committing') return false;
    this.#clearTimers(attempt);
    attempt.phase = 'preparing';
    attempt.readySent = false;
    this.#ports.onMutation({ source: 'handoff-prepare', action: 'load',
      suppressTelemetry: true, expiresAt: this.#ports.now() + 3_000 });
    const player = this.#ports.getPlayer();
    if (player && this.#muteLease?.player === player) {
      try { player.pauseVideo(); } catch {}
      if (!this.#current(attempt, player)) return false;
      try { player.mute(); } catch {}
    }
    if (!this.#current(attempt)) return false;
    this.#ports.onFailure(attempt.handoffId, reason);
    return true;
  }

  cancel() {
    const attempt = this.#attempt;
    if (!attempt) return false;
    this.#attempt = null;
    const epoch = ++this.#epoch;
    this.#clearTimers(attempt);
    const player = this.#ports.getPlayer();
    const lease = this.#muteLease;
    if (player && lease?.player === player) {
      try { player.pauseVideo(); } catch {}
      if (this.#epoch !== epoch) return false;
      if (lease.wasMuted === false) {
        try { player.unMute(); } catch {}
      }
    }
    if (this.#epoch !== epoch) return false;
    this.#muteLease = null;
    this.#ports.onNote('song.handoffCancelled');
    return true;
  }

  /** @param {unknown} handoffId */
  complete(handoffId) {
    const attempt = this.#attempt;
    if (!attempt || attempt.handoffId !== handoffId) return null;
    this.#attempt = null;
    const epoch = ++this.#epoch;
    this.#clearTimers(attempt);
    const player = this.#ports.getPlayer();
    const lease = this.#muteLease;
    const restoreAudible = player !== null && player === lease?.player && lease.wasMuted === false;
    if (restoreAudible) {
      try { player.unMute(); } catch {}
    }
    if (this.#epoch !== epoch) return null;
    this.#muteLease = null;
    this.#ports.onNote('song.handoffComplete');
    return { desiredState: attempt.desiredState, unmuteRequested: restoreAudible };
  }
}
