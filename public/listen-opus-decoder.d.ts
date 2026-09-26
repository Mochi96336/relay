export const LISTEN_OPUS_DECODER_CONFIG: Readonly<{
  codec: 'opus';
  sampleRate: 48_000;
  numberOfChannels: 1;
}>;

export function listenOpusDecodingSupported(options?: {
  AudioDecoderClass?: unknown;
  EncodedAudioChunkClass?: unknown;
}): Promise<boolean>;

export type ListenOpusFrame = {
  firstSampleIndex: number;
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
