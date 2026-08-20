import { toInt16 } from './harness.js';

const BAND_FREQUENCIES_HZ = [180, 340, 750, 1_500, 3_000, 5_000, 7_500] as const;
const BAR_PATTERNS = [
  [0, 1, 4],
  [2, 5, 6],
  [0, 3, 5],
  [1, 4, 6],
  [0, 2, 6],
  [1, 3, 5],
  [0, 4, 5],
  [2, 3, 6],
  [0, 1, 5],
  [2, 4, 6],
  [1, 3, 6],
  [0, 2, 4],
] as const;
const SECONDARY_OFFSETS_SECONDS = [0.08, 0.17, 0.11, 0.23, 0.14, 0.19, 0.07, 0.21, 0.13, 0.24, 0.09, 0.16] as const;
const SECONDARY_BANDS = [6, 3, 2, 5, 4, 0, 2, 1, 6, 3, 4, 5] as const;

type MusicPairOptions = {
  micBandGains?: readonly number[];
  singerGain?: number;
  agc?: boolean;
};

function addBurst(
  track: Float64Array,
  start: number,
  sampleRate: number,
  frequency: number,
  amplitude: number,
  durationSeconds: number,
  decay: number,
) {
  const length = Math.min(
    track.length - start,
    Math.round(sampleRate * durationSeconds),
  );
  if (length <= 0) return;

  for (let i = 0; i < length; i += 1) {
    const seconds = i / sampleRate;
    track[start + i] += Math.sin(2 * Math.PI * frequency * seconds)
      * amplitude
      * Math.exp(-seconds * decay);
  }
}

function musicTracks(samples: number, sampleRate: number) {
  const tracks = Array.from({ length: BAND_FREQUENCIES_HZ.length }, () => new Float64Array(samples));
  const beatSamples = Math.round(sampleRate * 0.5); // 120 BPM
  let beat = 0;

  for (let cursor = Math.round(sampleRate * 0.07); cursor < samples; cursor += beatSamples) {
    const patternIndex = beat % BAR_PATTERNS.length;
    const accent = 0.72 + ((beat * 37) % 17) / 100;

    for (const band of BAR_PATTERNS[patternIndex]) {
      addBurst(
        tracks[band],
        cursor,
        sampleRate,
        BAND_FREQUENCIES_HZ[band],
        accent * (band >= 4 ? 0.8 : 1),
        band >= 5 ? 0.08 : 0.14,
        band >= 4 ? 42 : 28,
      );
    }

    const secondaryStart = cursor + Math.round(
      sampleRate * SECONDARY_OFFSETS_SECONDS[patternIndex],
    );
    const secondaryBand = SECONDARY_BANDS[patternIndex];
    addBurst(
      tracks[secondaryBand],
      secondaryStart,
      sampleRate,
      BAND_FREQUENCIES_HZ[secondaryBand],
      0.28 + patternIndex * 0.012,
      0.055,
      58,
    );
    beat += 1;
  }

  return tracks;
}

function mixTracks(
  tracks: readonly Float64Array[],
  start: number,
  samples: number,
  gains: readonly number[],
) {
  const output = new Float64Array(samples);
  for (let band = 0; band < tracks.length; band += 1) {
    const gain = gains[band] ?? 1;
    if (gain === 0) continue;
    const track = tracks[band];
    for (let i = 0; i < samples; i += 1) output[i] += track[start + i] * gain;
  }
  return output;
}

function addSinger(values: Float64Array, sampleRate: number, gain: number) {
  if (!(gain > 0)) return;
  for (let i = 0; i < values.length; i += 1) {
    const seconds = i / sampleRate;
    const fundamental = 210 + 25 * Math.sin(2 * Math.PI * 0.35 * seconds);
    let voiced = 0;
    for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
      voiced += Math.sin(2 * Math.PI * fundamental * harmonic * seconds) / (harmonic * 1.2);
    }
    const envelope = 0.25 + 0.20 * Math.sin(2 * Math.PI * 0.7 * seconds) ** 2;
    values[i] += voiced * envelope * gain;
  }
}

function applyAgc(values: Float64Array, sampleRate: number) {
  for (let i = 0; i < values.length; i += 1) {
    const seconds = i / sampleRate;
    values[i] *= seconds < 2 ? 0.35 : seconds < 4 ? 0.75 : 0.5;
  }
}

export function laggedMultibandMusicPair(
  seconds: number,
  sampleRate: number,
  lagMs: number,
  options: MusicPairOptions = {},
) {
  const samples = Math.round(sampleRate * seconds);
  const lagSamples = Math.round((Math.abs(lagMs) * sampleRate) / 1_000);
  const tracks = musicTracks(samples + lagSamples, sampleRate);
  const micStart = lagMs >= 0 ? 0 : lagSamples;
  const backingStart = lagMs >= 0 ? lagSamples : 0;
  const unity = BAND_FREQUENCIES_HZ.map(() => 1);
  const micValues = mixTracks(
    tracks,
    micStart,
    samples,
    options.micBandGains ?? unity,
  );
  const backingValues = mixTracks(tracks, backingStart, samples, unity);

  addSinger(micValues, sampleRate, options.singerGain ?? 0);
  if (options.agc) applyAgc(micValues, sampleRate);

  return {
    mic: toInt16(micValues, 0.28, 0.002),
    backing: toInt16(backingValues, 0.55),
  };
}

export function sameEnvelopeDifferentSpectrumPair(seconds: number, sampleRate: number) {
  const samples = Math.round(sampleRate * seconds);
  const backingTracks = Array.from(
    { length: BAND_FREQUENCIES_HZ.length },
    () => new Float64Array(samples),
  );
  const micTracks = Array.from(
    { length: BAND_FREQUENCIES_HZ.length },
    () => new Float64Array(samples),
  );
  const backingSequence = [0, 2, 4, 1, 5, 3, 6, 0, 4, 2, 5, 1];
  const micSequence = [4, 0, 1, 6, 2, 5, 3, 4, 1, 5, 0, 6];
  const beatSamples = Math.round(sampleRate * 0.5);
  let beat = 0;

  for (let cursor = Math.round(sampleRate * 0.08); cursor < samples; cursor += beatSamples) {
    const backingBand = backingSequence[beat % backingSequence.length];
    const micBand = micSequence[beat % micSequence.length];
    addBurst(
      backingTracks[backingBand], cursor, sampleRate,
      BAND_FREQUENCIES_HZ[backingBand], 0.9, 0.12, 35,
    );
    addBurst(
      micTracks[micBand], cursor, sampleRate,
      BAND_FREQUENCIES_HZ[micBand], 0.9, 0.12, 35,
    );
    beat += 1;
  }

  const unity = BAND_FREQUENCIES_HZ.map(() => 1);
  return {
    backing: toInt16(mixTracks(backingTracks, 0, samples, unity), 0.55),
    mic: toInt16(mixTracks(micTracks, 0, samples, unity), 0.45),
  };
}

const SAME_BPM_BACKING_PATTERNS = [
  [1, 2, 3], [0, 2, 4], [0, 3, 5], [1, 2, 4],
  [1, 4, 5], [2, 4, 6], [0, 1, 3], [0, 2, 4],
  [1, 2, 4], [1, 5, 6], [2, 3, 6], [3, 4, 6],
] as const;
const SAME_BPM_MIC_PATTERNS = [
  [1, 3, 5], [0, 1, 5], [0, 3, 4], [0, 3, 5],
  [2, 4, 6], [1, 2, 5], [0, 1, 2], [2, 3, 4],
  [2, 3, 5], [4, 5, 6], [2, 5, 6], [1, 3, 6],
] as const;

const SAME_BPM_BACKING_SECONDARY_BANDS = [1, 2, 0, 3, 2, 1, 2, 5, 0, 1, 4, 2] as const;
const SAME_BPM_BACKING_SECONDARY_OFFSETS = [0.11, 0.11, 0.12, 0.09, 0.10, 0.08, 0.06, 0.07, 0.19, 0.10, 0.19, 0.12] as const;
const SAME_BPM_MIC_SECONDARY_BANDS = [1, 6, 4, 6, 6, 4, 1, 0, 1, 3, 2, 0] as const;
const SAME_BPM_MIC_SECONDARY_OFFSETS = [0.12, 0.12, 0.07, 0.08, 0.11, 0.21, 0.05, 0.15, 0.20, 0.08, 0.11, 0.13] as const;

function fixedPatternMusic(
  seconds: number,
  sampleRate: number,
  patterns: readonly (readonly number[])[],
  secondaryBands: readonly number[],
  secondaryOffsets: readonly number[],
) {
  const samples = Math.round(sampleRate * seconds);
  const tracks = Array.from(
    { length: BAND_FREQUENCIES_HZ.length },
    () => new Float64Array(samples),
  );
  const beatSamples = Math.round(sampleRate * 0.5);
  let beat = 0;

  for (let cursor = Math.round(sampleRate * 0.07); cursor < samples; cursor += beatSamples) {
    const index = beat % patterns.length;
    for (const band of patterns[index]) {
      addBurst(
        tracks[band], cursor, sampleRate, BAND_FREQUENCIES_HZ[band],
        0.48, band >= 5 ? 0.08 : 0.12, band >= 4 ? 45 : 30,
      );
    }
    const secondaryBand = secondaryBands[index];
    addBurst(
      tracks[secondaryBand],
      cursor + Math.round(sampleRate * secondaryOffsets[index]),
      sampleRate,
      BAND_FREQUENCIES_HZ[secondaryBand],
      0.18,
      0.05,
      60,
    );
    beat += 1;
  }

  const unity = BAND_FREQUENCIES_HZ.map(() => 1);
  return mixTracks(tracks, 0, samples, unity);
}

export function sameBpmDifferentMusicPair(seconds: number, sampleRate: number) {
  return {
    backing: toInt16(
      fixedPatternMusic(
        seconds, sampleRate, SAME_BPM_BACKING_PATTERNS,
        SAME_BPM_BACKING_SECONDARY_BANDS, SAME_BPM_BACKING_SECONDARY_OFFSETS,
      ),
      0.55,
    ),
    mic: toInt16(
      fixedPatternMusic(
        seconds, sampleRate, SAME_BPM_MIC_PATTERNS,
        SAME_BPM_MIC_SECONDARY_BANDS, SAME_BPM_MIC_SECONDARY_OFFSETS,
      ),
      0.45,
    ),
  };
}

export function singleBandBeatPair(
  seconds: number,
  sampleRate: number,
  lagMs: number,
  periodMs = 500,
) {
  const samples = Math.round(sampleRate * seconds);
  const lagSamples = Math.round((Math.abs(lagMs) * sampleRate) / 1_000);
  const master = new Float64Array(samples + lagSamples);
  const periodSamples = Math.round((sampleRate * periodMs) / 1_000);

  for (let cursor = Math.round(sampleRate * 0.05); cursor < master.length; cursor += periodSamples) {
    addBurst(master, cursor, sampleRate, 180, 0.8, 0.12, 40);
  }

  const micStart = lagMs >= 0 ? 0 : lagSamples;
  const backingStart = lagMs >= 0 ? lagSamples : 0;
  return {
    mic: toInt16(master.subarray(micStart, micStart + samples), 0.45),
    backing: toInt16(master.subarray(backingStart, backingStart + samples), 0.9),
  };
}
