import { shouldSetPlaybackRate } from './room-song-seek-policy.js';
import { ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS } from './room-song-command-convergence.js';

/**
 * @typedef {{
 *   getVideoData(): {video_id?: unknown} | null,
 *   getPlayerState(): unknown, getCurrentTime(): unknown,
 *   getPlaybackRate?: () => unknown,
 *   loadVideoById(input: {videoId: string, startSeconds: number}): void,
 *   cueVideoById?: (input: {videoId: string, startSeconds: number}) => void,
 *   seekTo(position: number, allowSeekAhead: boolean): void,
 *   setPlaybackRate(rate: number): void, playVideo(): void, pauseVideo(): void,
 * }} YouTubePlaybackPlayer
 * @typedef {{videoId: string, positionSeconds: number, state: number, playbackRate: number}} PlaybackTarget
 * @typedef {{mode?: 'load' | 'cue' | 'reuse', seek?: boolean | 'if-drifted', isCurrent?: () => boolean}} TargetOptions
 */

/**
 * One desired media state, reconciled against asynchronous iframe observations.
 * Owners decide authority, audibility, deadlines and iframe lifetime. Before
 * CUED replaces media they honor needsFreshCuePlayer(); retiring a JS target
 * cannot recall iframe requests. This adapter alone decides
 * how load/cue/seek/play/pause achieve their desired physical player state.
 *
 * Commands are requests, not observations. A paused reused player needs Play;
 * a loaded dormant video must reach PLAYING before Pause can park real media.
 * Each outstanding command is sent once, even with reentrant player callbacks.
 */
export class YouTubePlaybackTarget {
  // A posted media request cannot be recalled by retiring its JS owner. A new
  // dormant controller must use a fresh iframe after this player requested media.
  /** @type {WeakSet<object>} */
  static #mediaPlayers = new WeakSet();

  /** @param {{getPlayerState(): unknown}} player */
  static needsFreshCuePlayer(player) {
    if (this.#mediaPlayers.has(player)) return true;
    try { return [0, 1, 2, 3].includes(Number(player.getPlayerState())); }
    catch { return false; } // An initializing, unrequested iframe has no media to retire.
  }

  /** @type {YouTubePlaybackPlayer} */
  #player;
  /** @type {PlaybackTarget} */
  #desired;
  /** @type {Required<TargetOptions>} */
  #options;
  #started = false;
  #positionApplied = false;
  #positionRequested = false;
  #explicitSeekPending = false;
  #lastState = Number.NaN;
  #rateRequested = false;
  #observedRate = Number.NaN;
  #stateRequested = false;
  #observing = false;
  #retired = false;
  #converged = false;

  /** @param {YouTubePlaybackPlayer} player @param {PlaybackTarget} desired @param {TargetOptions} [options] */
  constructor(player, desired, options = {}) {
    this.#player = player;
    this.#desired = { ...desired, state: [1, 3].includes(desired.state) ? 1 : desired.state === 5 ? 5 : 2 };
    this.#options = { mode: 'reuse', seek: false, isCurrent: () => true, ...options };
    this.#explicitSeekPending = this.#options.seek === true;
  }

  retire() { this.#retired = true; }

  get converged() { return this.#converged; }

  #current() { return !this.#retired && this.#options.isCurrent(); }

  /** Apply once, then call on state/rate events or bounded readiness polls. */
  observe() {
    if (!this.#current() || this.#observing) return;
    this.#observing = true;
    try {
      const player = this.#player;
      const desired = this.#desired;
      let changed = false;
      if (!this.#started) {
        this.#started = true;
        if (this.#options.mode !== 'reuse') {
          changed = true;
          this.#positionApplied = this.#options.mode === 'cue';
          const input = { videoId: desired.videoId, startSeconds: desired.positionSeconds };
          if (this.#options.mode === 'cue') {
            if (!player.cueVideoById) throw new Error('YouTube cueVideoById is unavailable');
            player.cueVideoById(input);
          } else {
            YouTubePlaybackTarget.#mediaPlayers.add(player);
            player.loadVideoById(input);
          }
        }
      }
      let videoId;
      try { videoId = player.getVideoData()?.video_id; } catch { return; }
      if (!this.#current() || videoId !== desired.videoId) return;

      let state;
      try { state = Number(player.getPlayerState()); } catch { return; }
      if ([0, 1, 2, 3].includes(state)) YouTubePlaybackTarget.#mediaPlayers.add(player);
      if (state !== this.#lastState) this.#positionRequested = false;
      if (!this.#current()) return;
      // An old cue/load can finish after its owner was retired. Re-entering a
      // setup state invalidates the position proof, so the current owner repairs
      // it instead of trusting the startSeconds of a request that already ran.
      if ([-1, 5].includes(state) && Number.isFinite(this.#lastState)
          && ![-1, 5].includes(this.#lastState) && this.#options.mode !== 'cue') {
        this.#converged = false;
        this.#positionApplied = false;
        this.#positionRequested = false;
        this.#stateRequested = false;
      }
      this.#lastState = state;
      // Once observed, ordinary native Pause/rate changes and natural ENDED
      // belong to the next intent. Only a stale setup callback needs repair.
      if (this.#converged) return;
      if (!this.#positionApplied && state >= 0 && state !== 3) {
        let position = Number.NaN;
        try { position = Number(player.getCurrentTime()); } catch {}
        if (!this.#current()) return;
        const displaced = !Number.isFinite(position)
          || Math.abs(position - desired.positionSeconds) > ROOM_SONG_LOCAL_JUMP_TOLERANCE_SECONDS;
        const ownsPosition = this.#options.mode === 'load' || this.#options.seek !== false;
        if (ownsPosition && !this.#positionRequested && (displaced || this.#explicitSeekPending)) {
          changed = true;
          this.#positionRequested = true;
          this.#explicitSeekPending = false;
          YouTubePlaybackTarget.#mediaPlayers.add(player);
          player.seekTo(desired.positionSeconds, true);
        } else if (!ownsPosition || !displaced) this.#positionApplied = true;
      }
      if (!this.#current()) return;
      let rate = Number.NaN;
      try { rate = Number(player.getPlaybackRate?.()); } catch {}
      if (!this.#current()) return;
      if (Number.isFinite(rate) && rate !== this.#observedRate) {
        this.#observedRate = rate;
        this.#rateRequested = false;
      }
      if (!this.#rateRequested && shouldSetPlaybackRate({ currentRate: rate, desiredRate: desired.playbackRate })) {
        changed = true;
        this.#rateRequested = true;
        player.setPlaybackRate(desired.playbackRate);
      }
      if (!this.#current()) return;
      try { state = Number(player.getPlayerState()); } catch { return; }
      if (!this.#current()) return;
      if (!this.#stateRequested && desired.state !== 5) {
        if (desired.state === 1 && state !== 1 && state !== 3
            && (this.#options.mode === 'reuse' || state === 2 || state === 5 || state === 0)) {
          changed = true;
          this.#stateRequested = true;
          YouTubePlaybackTarget.#mediaPlayers.add(player);
          player.playVideo();
        } else if (desired.state !== 1 && (state === 1 || state === 5 && this.#options.mode === 'reuse')) {
          changed = true;
          this.#stateRequested = true;
          player.pauseVideo();
        }
      }
      if (!changed && state === desired.state && this.#positionApplied
          && (!player.getPlaybackRate || Math.abs(rate - desired.playbackRate) <= 0.0001)) {
        this.#converged = true;
      }
    } finally { this.#observing = false; }
  }
}
