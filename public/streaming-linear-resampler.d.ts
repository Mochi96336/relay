export type StreamingLinearResampleOptions = {
  sourceRate: number;
  targetRate: number;
  firstSampleIndex: number;
};

export type StreamingLinearResampler = {
  reset(): void;
  resample(
    input: Float32Array,
    options: StreamingLinearResampleOptions,
  ): Float32Array;
};

export function createStreamingLinearResampler(): StreamingLinearResampler;
