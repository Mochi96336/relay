export const LUFS_SILENCE: number;
export type BiquadCoefficients = { b: [number, number, number]; a: [number, number] };
export function kWeightingCoefficients(sampleRate: number): Readonly<{ shelf: BiquadCoefficients; highPass: BiquadCoefficients }>;
export function lufsFromMeanSquare(meanSquare: number): number;

/** BS.1770 loudness of one channel: momentary (400 ms) and short-term (3 s). */
export class LoudnessMeter {
  constructor(sampleRate?: number);
  readonly sampleRate: number;
  /** One sample, full scale ±1. Returns true when it completed a 100 ms block. */
  push(x: number): boolean;
  readonly momentaryLufs: number | null;
  readonly shortTermLufs: number | null;
  readonly momentaryMeanSquare: number | null;
  reset(): void;
}

/** Gated integrated loudness from 400 ms block mean squares. */
export class IntegratedLoudness {
  add(meanSquare: number | null): void;
  readonly blockCount: number;
  readonly lufs: number | null;
}
