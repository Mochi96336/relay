export function createOpusEncoder(bytes: BufferSource, bitrate?: number): {
  delaySamples: number;
  reset(): void;
  encode(pcm: ArrayBuffer): Uint8Array;
};
