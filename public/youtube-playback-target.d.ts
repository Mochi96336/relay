export type YouTubePlaybackPlayer = {
    getVideoData(): {
        video_id?: unknown;
    } | null;
    getPlayerState(): unknown;
    getCurrentTime(): unknown;
    getPlaybackRate?: () => unknown;
    loadVideoById(input: {
        videoId: string;
        startSeconds: number;
    }): void;
    cueVideoById?: (input: {
        videoId: string;
        startSeconds: number;
    }) => void;
    seekTo(position: number, allowSeekAhead: boolean): void;
    setPlaybackRate(rate: number): void;
    playVideo(): void;
    pauseVideo(): void;
};
export type PlaybackTarget = {
    videoId: string;
    positionSeconds: number;
    state: number;
    playbackRate: number;
};
export type TargetOptions = {
    mode?: 'load' | 'cue' | 'reuse';
    seek?: boolean | 'if-drifted';
    isCurrent?: () => boolean;
};
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
 * Owners decide authority, audibility and deadlines. This adapter alone decides
 * how load/cue/seek/play/pause achieve their desired physical player state.
 *
 * Commands are requests, not observations. A paused reused player needs Play;
 * a loaded dormant video must reach PLAYING before Pause can park real media.
 * Each outstanding command is sent once, even with reentrant player callbacks.
 */
export declare class YouTubePlaybackTarget {
    #private;
    /** @param {YouTubePlaybackPlayer} player @param {PlaybackTarget} desired @param {TargetOptions} [options] */
    constructor(player: YouTubePlaybackPlayer, desired: PlaybackTarget, options?: TargetOptions);
    retire(): void;
    get converged(): boolean;
    /** Apply once, then call on state/rate events or bounded readiness polls. */
    observe(): void;
}
