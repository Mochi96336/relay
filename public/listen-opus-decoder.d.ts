export const LISTEN_OPUS_DECODER_CONFIG: Readonly<{
  codec: 'opus';
  sampleRate: 48_000;
  numberOfChannels: 1;
}>;

export function listenOpusDecodingSupported(options?: {
  AudioDecoderClass?: unknown;
  EncodedAudioChunkClass?: unknown;
}): Promise<boolean>;

export const LISTEN_OPUS_QUERY_DEADLINE_MS: number;
export function opusCapabilityWithin(capability: Promise<boolean>, deadlineMs?: number): Promise<boolean>;

export type ListenOpusFrame = {
  firstSampleIndex: number;
  sampleCount: number;
  packet: ArrayBuffer;
};

export function createListenOpusDecoder(options: {
  onPcm: (pcm: Float32Array, firstSampleIndex: number) => void;
  onError: (error: Error) => void;
  AudioDecoderClass?: unknown;
  EncodedAudioChunkClass?: unknown;
}): {
  decode(frame: ListenOpusFrame): void;
  reset(): void;
};
