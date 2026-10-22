import { YouTubePlaybackTarget } from './youtube-playback-target.js';

// Server proof expires after 5 s; this later watchdog only contains local damage.
export const HANDOFF_COMMIT_TIMEOUT_MS = 6_500;
const REALIGN_THRESHOLD_SECONDS = 0.75;
const READY_CHECK_DELAYS_MS = [80, 220, 500, 900, 1_500, 2_400, 4_000, 7_000, 11_000, 16_000];
/**
 * A preparation still not ready this long after it began says why, once.
 * The server gives up at 20 s; before this report a stuck tab was silent.
 */
export const HANDOFF_STALL_REPORT_MS = 15_000;

/**
 * @typedef {{
 *   getVideoData(): {video_id?: unknown} | null,
 *   getPlayerState(): unknown,
 *   getCurrentTime(): unknown,
 *   getPlaybackRate?: () => unknown,
 *   getVideoLoadedFraction(): unknown,
 *   isMuted(): boolean,
 *   mute(): void,
 *   unMute(): void,
 *   cueVideoById?: (input: {videoId: string, startSeconds: number}) => void,
 *   loadVideoById(input: {videoId: string, startSeconds: number}): void,
 *   seekTo(position: number, allowSeekAhead: boolean): void,
 *   setPlaybackRate(rate: number): void,
 *   playVideo(): void,
 *   pauseVideo(): void,
 * }} HandoffPlayer
 * @typedef {{handoffId: string, videoId: string, targetTime: number, desiredState: number, playbackRate: number}} HandoffPlan
 * @typedef {HandoffPlan & {phase: 'preparing' | 'committing'}} HandoffState
 * @typedef {{
 *   blocker: string | null, playerState: number | null, buffered: number | null, muted: boolean | null,
 * }} HandoffReadiness
 * @typedef {{timers: number[]}} SampleJob
 * @typedef {HandoffState & {
 *   reusePreparedPlayer: boolean, readySent: boolean, timerEpoch: number,
 *   timers: Set<number>, samples: SampleJob | null, stallTimer: number | null, media: YouTubePlaybackTarget | null,
 * }} Attempt
 * @typedef {{
 *   source: 'handoff-prepare' | 'handoff-commit', action: 'load' | 'play' | 'pause',
 *   suppressTelemetry: boolean, expiresAt: number,
 * }} HandoffMutation
 * @typedef {{
 *   getPlayer: () => HandoffPlayer | null,
 *   ensurePlayer: (videoId: string, isCurrent: () => boolean, options?: {cue: boolean}) => Promise<unknown>,
 *   onMutation: (mutation: HandoffMutation) => void,
 *   onTimelineBoundary: (videoId: string | null) => void,
 *   onNote: (key: string) => void,
 *   onReady: (handoffId: string) => void,
 *   onFailure: (handoffId: string, reason: string) => void,
 *   onStalled?: (handoffId: string, readiness: HandoffReadiness) => void,
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
      onStalled: ports.onStalled ?? (() => {}),
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

  /** @param {Attempt} attempt */
  #clearStallReport(attempt) {
    if (attempt.stallTimer !== null) this.#ports.clearTimer(attempt.stallTimer);
    attempt.stallTimer = null;
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
      this.#muteLease = { player, wasMuted: this.#muteLease?.wasMuted ?? Boolean(player.isMuted()) };
    }
  }

  /** @param {HandoffPlan} plan @param {{reusePreparedPlayer?: boolean, wasMuted?: boolean | null}} [preparation] */
  async prepare(plan, { reusePreparedPlayer = false, wasMuted = null } = {}) {
    const previous = this.#attempt;
    const player = this.#ports.getPlayer();
    if (previous) {
      this.#clearTimers(previous);
      this.#clearStallReport(previous);
      previous.media?.retire();
    }
    // The lease survives replacing a preparation, including synchronous player
    // callbacks during retirement. Relay's own mute is never a new preference.
    if (this.#muteLease?.player !== player) this.#muteLease = null;
    if (!this.#muteLease && player && wasMuted !== null) this.#muteLease = { player, wasMuted };
    this.#epoch += 1;
    /** @type {Attempt} */
    const attempt = { ...plan, phase: 'preparing', reusePreparedPlayer,
      readySent: false, timerEpoch: 0, timers: new Set(), samples: null, stallTimer: null, media: null };
    this.#attempt = attempt;
    this.#ports.onNote('song.preparingHandoff');
    // Outside the attempt's timers: cue() clears those, and a player that never
    // becomes ready never reaches cue() at all.
    attempt.stallTimer = this.#ports.setTimer(() => {
      attempt.stallTimer = null;
      if (!this.#current(attempt) || attempt.phase !== 'preparing' || attempt.readySent) return;
      this.#ports.onStalled(attempt.handoffId, this.readiness());
    }, HANDOFF_STALL_REPORT_MS);
    try {
      // Capture before ensurePlayer can replace the iframe. A mute sent to its
      // successor is asynchronous and must not redefine the user's preference.
      if (player && !this.#muteLease) {
        try { this.#acquireMuteLease(player); }
        catch (error) {
          if (this.#current(attempt)) {
            this.#ports.warn('Could not read handoff mute provenance', error);
            this.#ports.onFailure(attempt.handoffId, 'prepare-failed');
          }
          return false;
        }
      }
      await this.#ports.ensurePlayer(plan.videoId, () => this.#current(attempt), { cue: plan.desiredState === 5 });
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
      attempt.media?.retire();
      attempt.media = new YouTubePlaybackTarget(player, {
        videoId: attempt.videoId, positionSeconds: Math.max(0, attempt.targetTime),
        state: attempt.desiredState, playbackRate: attempt.playbackRate,
      }, {
        mode: attempt.desiredState === 5 ? 'cue'
          : attempt.reusePreparedPlayer && this.#videoId(player) === attempt.videoId ? 'reuse' : 'load',
        seek: 'if-drifted',
        isCurrent: () => this.#current(attempt, player) && attempt.phase === 'preparing',
      });
      attempt.media.observe();
      if (!this.#current(attempt, player)) return false;
      this.#clearTimers(attempt);
      for (const delay of READY_CHECK_DELAYS_MS) this.#later(attempt, delay, () => {
        try { attempt.media?.observe(); } catch {}
        this.announceReady();
      });
      return true;
    } catch (error) {
      if (this.#current(attempt)) {
        this.#ports.warn('Could not prepare room song handoff', error);
        this.#ports.onFailure(attempt.handoffId, 'prepare-failed');
      }
      return false;
    }
  }

  /**
   * What still keeps the preparing player from being ready, with the player
   * readings behind it. `blocker` is null once announceReady would succeed.
   * @returns {HandoffReadiness}
   */
  readiness() {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    /** @type {Omit<HandoffReadiness, 'blocker'>} */
    const readings = { playerState: null, buffered: null, muted: null };
    /** @param {string | null} blocker @returns {HandoffReadiness} */
    const result = (blocker) => ({ blocker, ...readings });
    if (!attempt || attempt.phase !== 'preparing') return result('no-preparation');
    if (!player) return result('player-not-ready');
    try {
      const state = Number(player.getPlayerState());
      const buffered = Number(player.getVideoLoadedFraction());
      readings.playerState = Number.isFinite(state) ? state : null;
      readings.buffered = Number.isFinite(buffered) ? buffered : null;
      readings.muted = Boolean(player.isMuted());
    } catch { return result('player-unreadable'); }
    if (this.#muteLease?.player !== player) return result('mute-lease-missing');
    if (this.#videoId(player) !== attempt.videoId) return result('video-not-loaded');
    if (!readings.muted) return result('not-muted');
    const playing = attempt.desiredState === 1 || attempt.desiredState === 3;
    if (readings.playerState !== (attempt.desiredState === 5 ? 5 : playing ? 1 : 2)) return result(`state-${readings.playerState ?? 'unknown'}`);
    if (attempt.desiredState !== 5 && (readings.buffered === null || readings.buffered <= 0)) return result('not-buffered');
    return result(null);
  }

  announceReady() {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    if (!attempt || attempt.readySent || !player || this.readiness().blocker !== null) return false;
    if (!this.#current(attempt, player)) return false;
    attempt.readySent = true;
    this.#clearTimers(attempt);
    this.#clearStallReport(attempt);
    this.#ports.onNote('song.handoffPrepared');
    this.#ports.onReady(attempt.handoffId);
    return true;
  }

  /** Reconcile on events and the existing telemetry tick; deadlines stay with the owner. */
  reconcile() {
    const attempt = this.#attempt;
    const player = this.#ports.getPlayer();
    if (!attempt || !player) return;
    try { attempt.media?.observe(); } catch (error) {
      this.#ports.warn('Could not reconcile handoff playback', error);
      return;
    }
    if (attempt.phase === 'preparing' && this.#current(attempt, player)) this.announceReady();
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
    this.#clearStallReport(attempt);
    attempt.media?.retire();
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
      attempt.media = new YouTubePlaybackTarget(player, {
        videoId: attempt.videoId, positionSeconds: attempt.targetTime,
        state: attempt.desiredState, playbackRate: attempt.playbackRate,
      }, {
        mode: attempt.desiredState === 5 ? 'cue'
          : this.#videoId(player) !== attempt.videoId ? 'load' : 'reuse',
        seek: 'if-drifted',
        isCurrent: () => this.#current(attempt, player) && attempt.phase === 'committing',
      });
      attempt.media.observe();
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
    // A dormant room does not move, and the commit already carries where the
    // server wants it: the room's raw position may be the very end, which
    // YouTube cannot hold as PAUSED.
    if (attempt.desiredState !== 1) return false;
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
      attempt.media?.retire();
      attempt.media = new YouTubePlaybackTarget(player, {
        videoId: attempt.videoId, positionSeconds: attempt.targetTime,
        state: attempt.desiredState, playbackRate: attempt.playbackRate,
      }, { seek: true, isCurrent: () => this.#current(attempt, player) && attempt.phase === 'committing' });
      attempt.media.observe();
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
    this.#clearStallReport(attempt);
    attempt.media?.retire();
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
    this.#clearStallReport(attempt);
    attempt.media?.retire();
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
