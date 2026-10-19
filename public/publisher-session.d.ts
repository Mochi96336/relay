import { MicStartupGate } from './mic-startup.js';
export type StartupAttempt = import('./mic-startup.js').MicStartupAttempt;
export type CaptureGraph = import('./mic-capture-graph.js').MicCaptureGraph;
export type PublisherEncoder = {
    readonly bitrate: number;
    encode(pcm: ArrayBuffer, sequence: number, firstSampleIndex: number): boolean;
    reset(generation: number): void;
    setBitrate(bitrate: number): void;
    close(): void;
};
export type PreparedCapture = {
    stream: MediaStream;
    context: AudioContext;
    encoder: PublisherEncoder | null;
};
export type Resources = PreparedCapture & {
    graph: CaptureGraph | null;
    socket: WebSocket | null;
};
export type CaptureSnapshot = {
    epoch: number;
    generation: number;
    stream: MediaStream;
    context: AudioContext;
    graph: CaptureGraph | null;
};
export type RetiredSession = {
    epoch: number;
    finish(options: {
        releaseMic: boolean;
    }): Promise<number>;
};
/**
 * Owns one Mic session, including its prepared capture and physical resources.
 * Revocation is synchronous; asynchronous teardown touches only retired resources.
 * A stable token identifies terminal transactions even after the epoch is revoked.
 * DOM presentation, capture policy and transport protocols stay with their callers.
 */
export declare class PublisherSession {
    #private;
    /** @param {{closeMedia: () => void, startup?: MicStartupGate}} options */
    constructor({ closeMedia, startup }: {
        closeMedia: () => void;
        startup?: MicStartupGate;
    });
    get startup(): MicStartupGate;
    get epoch(): number;
    get active(): boolean;
    get starting(): boolean;
    get context(): AudioContext | null;
    get stream(): MediaStream | null;
    get encoder(): PublisherEncoder | null;
    get socket(): WebSocket | null;
    get graph(): import("./mic-capture-graph.js").MicCaptureGraph | null;
    get graphEpoch(): number;
    get generation(): number;
    get generationReason(): string;
    get recovering(): boolean;
    beginStartup(): object;
    /** @param {StartupAttempt} attempt @param {PreparedCapture} capture */
    activate(attempt: StartupAttempt, capture: PreparedCapture): number | null;
    /** @param {string} reason */
    advanceGeneration(reason: string): number;
    /** @param {number} epoch */
    isCurrentSession(epoch: number): boolean;
    /** @param {number} epoch @param {number} generation */
    isCurrentCapture(epoch: number, generation: number): boolean;
    /** @param {CaptureGraph | null} graph */
    isCurrentGraph(graph: CaptureGraph | null): boolean;
    /** Admit a completely constructed graph; stale preparation cleans only itself.
     * @param {number} epoch @param {CaptureGraph} graph */
    adoptGraph(epoch: number, graph: CaptureGraph): boolean;
    /** @param {CaptureSnapshot} snapshot */
    dropGraph(snapshot: CaptureSnapshot): boolean;
    /** The caller retains prepared context ownership when admission fails.
     * @param {CaptureSnapshot} snapshot @param {AudioContext} prepared */
    replaceContext(snapshot: CaptureSnapshot, prepared: AudioContext): boolean;
    /** @param {number} epoch @param {number} generation @param {WebSocket} socket */
    bindSocket(epoch: number, generation: number, socket: WebSocket): boolean;
    /** @param {WebSocket} socket */
    detachSocket(socket: WebSocket): boolean;
    /** Context and graph recovery share one operation per current capture.
     * @param {(snapshot: CaptureSnapshot, isCurrent: () => boolean) => Promise<boolean>} operation */
    recover(operation: (snapshot: CaptureSnapshot, isCurrent: () => boolean) => Promise<boolean>): Promise<boolean>;
    /** Install deduplication before starting effects, including reentrant events.
     * @param {() => Promise<void>} operation */
    requestStart(operation: () => Promise<void>): Promise<void>;
    retire(): RetiredSession;
    /** Emit terminal completion once, after cleanup, only for this stable session.
     * @param {{stop: () => Promise<number>, onEnded: () => void}} options */
    end({ stop, onEnded }: {
        stop: () => Promise<number>;
        onEnded: () => void;
    }): Promise<boolean>;
}
