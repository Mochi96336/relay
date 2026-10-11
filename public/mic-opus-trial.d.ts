export function createMicOpusTrial(options: {
  bitrate?: number;
  onPacket: (packet: ArrayBuffer) => void;
  onDrop: (sampleCount: number, reason: string) => void;
  onError?: (error?: Error) => void;
  onBitrate?: (bitrate: number) => void;
}): Promise<{
  readonly bitrate: number;
  setBitrate(value: number): void;
  reset(generation: number): void;
  encode(pcm: ArrayBuffer, sequence: number, firstSampleIndex: number): boolean;
  close(): void;
}>;
