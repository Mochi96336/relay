export type StreamingResampleOptions = {
  sourceRate: number;
  targetRate: number;
  firstSampleIndex: number;
};

export type StreamingResampler = {
  reset(): void;
  resample(
    input: Float32Array,
    options: StreamingResampleOptions,
  ): Float32Array;
};

export function createStreamingResampler(): StreamingResampler;
