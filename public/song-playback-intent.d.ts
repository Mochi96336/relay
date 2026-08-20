export declare const BUFFERING: 3;
export declare const PLAYING: 1;

export declare function settledPlaybackState(
  previous: { state?: number | null; previousSettledState?: number | null } | null | undefined,
): number | null;

export declare function isNewPlayIntent(sample: {
  state: number;
  previousState: number | null;
  previousSettledState?: number | null;
}): boolean;
