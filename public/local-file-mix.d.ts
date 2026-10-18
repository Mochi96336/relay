export const LOCAL_FILE_OFFSET_KEY: string;
export const LOCAL_FILE_MUSIC_LEVEL_KEY: string;
export const MAX_OFFSET_MS: number;

export function roundTripLatencySeconds(input: {
  baseLatency?: number;
  outputLatency?: number;
  inputLatency?: number;
}): number;
export function songDelaySeconds(roundTripSeconds: number, offsetMs: number): number;

export function localFileSurface(input: {
  fileOpen: boolean;
  myId: string | null | undefined;
  micOwnerId: string | null;
  roomLocalFile: unknown;
}): 'owner' | 'standby' | 'observer' | 'none';
export function lostMicToAnother(input: {
  previousOwnerId: string | null;
  nextOwnerId: string | null;
  myId: string | null | undefined;
}): boolean;

/** What mic-capture-graph hands the input hook; nodes are Web Audio nodes in a page. */
export type LocalFileCaptureInput = {
  context: any;
  stream: any;
  source: any;
  capture: any;
};

export class LocalFileMix extends EventTarget {
  constructor(options?: { createElement?: () => any });
  readonly active: boolean;
  readonly title: string | null;
  readonly attached: boolean;
  readonly playing: boolean;
  readonly currentTime: number;
  readonly duration: number | null;
  readonly roundTripMs: number;
  readonly offsetMs: number;
  readonly musicLevel: number;
  open(file: Blob & { name: string }): void;
  close(): void;
  connectInput: (input: LocalFileCaptureInput) => { disconnect(): void } | null;
  play(): Promise<boolean>;
  pause(): void;
  seek(seconds: number): void;
  setOffsetMs(value: number): void;
  setMusicLevel(value: number): void;
  setVocalGainDb(db: number): void;
}

export const localFileMix: LocalFileMix;
