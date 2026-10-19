export declare const HANDOFF_COMMIT_TIMEOUT_MS = 6500;
export type HandoffPlayer = {
    getVideoData(): {
        video_id?: unknown;
    } | null;
    getPlayerState(): unknown;
    getCurrentTime(): unknown;
    getVideoLoadedFraction(): unknown;
    isMuted(): boolean;
    mute(): void;
    unMute(): void;
    loadVideoById(input: {
        videoId: string;
        startSeconds: number;
    }): void;
    seekTo(position: number, allowSeekAhead: boolean): void;
    setPlaybackRate(rate: number): void;
    playVideo(): void;
    pauseVideo(): void;
};
export type HandoffPlan = {
    handoffId: string;
    videoId: string;
    targetTime: number;
    desiredState: number;
    playbackRate: number;
};
export type HandoffState = HandoffPlan & {
    phase: 'preparing' | 'committing';
};
export type SampleJob = {
    timers: number[];
};
export type Attempt = HandoffState & {
    reusePreparedPlayer: boolean;
    readySent: boolean;
    timerEpoch: number;
    timers: Set<number>;
    samples: SampleJob | null;
};
export type HandoffMutation = {
    source: 'handoff-prepare' | 'handoff-commit';
    action: 'load' | 'play' | 'pause';
    suppressTelemetry: boolean;
    expiresAt: number;
};
export type HandoffPorts = {
    getPlayer: () => HandoffPlayer | null;
    ensurePlayer: (videoId: string, isCurrent: () => boolean) => Promise<unknown>;
    onMutation: (mutation: HandoffMutation) => void;
    onTimelineBoundary: (videoId: string | null) => void;
    onNote: (key: string) => void;
    onReady: (handoffId: string) => void;
    onFailure: (handoffId: string, reason: string) => void;
    sampleNow: () => void;
    now?: () => number;
    setTimer?: (callback: () => void, delayMs: number) => number;
    clearTimer?: (timer: number) => void;
    warn?: (message: string, error: unknown) => void;
};
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
export declare class PlaybackHandoff {
    #private;
    /** @param {HandoffPorts} ports */
    constructor(ports: HandoffPorts);
    /** @returns {Readonly<HandoffState> | null} */
    get pending(): Readonly<HandoffState> | null;
    /** @param {HandoffPlan} plan @param {{reusePreparedPlayer?: boolean, wasMuted?: boolean | null}} [preparation] */
    prepare(plan: HandoffPlan, { reusePreparedPlayer, wasMuted }?: {
        reusePreparedPlayer?: boolean;
        wasMuted?: boolean | null;
    }): Promise<boolean>;
    cue(): boolean;
    announceReady(): boolean;
    /** @param {number} state */
    observeState(state: number): void;
    /** @param {{handoffId?: unknown, serverTime?: unknown, state?: unknown}} message */
    commit(message: {
        handoffId?: unknown;
        serverTime?: unknown;
        state?: unknown;
    }): boolean;
    /** @param {{handoffState?: unknown, handoffId?: unknown, serverTime?: unknown} | null} timeline */
    realign(timeline: {
        handoffState?: unknown;
        handoffId?: unknown;
        serverTime?: unknown;
    } | null): boolean;
    /** @param {string} reason */
    rollback(reason: string): boolean;
    cancel(): boolean;
    /** @param {unknown} handoffId */
    complete(handoffId: unknown): {
        desiredState: number;
        unmuteRequested: boolean;
    } | null;
}
