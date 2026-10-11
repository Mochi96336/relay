export function createMicOpusTrial(options: {
  bitrate?: number;
  onPacket: (packet: ArrayBuffer) => void;
  onDrop: (sampleCount: number, reason: string) => void;
  onError?: (error?: Error) => void;
}): Promise<{
  reset(generation: number): void;
  encode(pcm: ArrayBuffer, sequence: number, firstSampleIndex: number): boolean;
  close(): void;
}>;
