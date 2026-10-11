export function createOpusEncoder(bytes: BufferSource, bitrate?: number): {
  delaySamples: number;
  setBitrate(value: number): void;
  reset(): void;
  encode(pcm: ArrayBuffer): Uint8Array;
};
