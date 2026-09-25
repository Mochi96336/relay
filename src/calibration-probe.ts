/**
 * A known, non-repeating sound instead of the song's own content.
 *
 * Correlating against the song is inherently ambiguous for anything with a
 * beat: a true match and a copy shifted by the beat's own period can both be
 * genuinely strong correlations, not noise, and tightening thresholds cannot
 * fix an ambiguity that is a property of the signal being correlated, not of
 * the threshold. Three short notes at irregular offsets have no self-similar
 * repeat to alias onto, so the detector can look for both their timing and
 * their known frequencies instead of treating every loud beat as probe energy.
 *
 * The client (public/app.js, playCalibrationProbe) plays the audible version
 * of the same three notes - same offsets, frequencies and decay - through the
 * phone speaker on the same clock domain its own mic capture uses. It does
 * not need to match this module's PCM byte for byte, only its shape closely
 * enough for correlation to lock onto it; keep the two in sync by hand.
 */

const FEATURE_FRAME_MS = 5;

/**
 * A restrained C6-E6-G6 success chime. The unequal 125/205 ms gaps are
 * intentional: no lag other than the true one lines all three notes up.
 * Keep this list in sync with public/app.js and public/source.js.
 */
export const PROBE_NOTES = [
  { offsetMs: 0, frequencyHz: 1046.5, gain: 0.24 },
  { offsetMs: 125, frequencyHz: 1318.5, gain: 0.27 },
  { offsetMs: 330, frequencyHz: 1568, gain: 0.32 },
] as const;

/** A quick decay keeps the chime light while leaving enough energy to detect. */
const NOTE_DECAY_PER_SECOND = 70;
/** Long enough after the last note's onset for it to have decayed away. */
export const PROBE_REFERENCE_MS = 470;

export type ProbeLocation = {
  /** Where the reference's first note was found, in samples from the window's own start. */
  offsetSamples: number;
  correlation: number;
};

function noteSample(secondsIntoNote: number, frequencyHz: number): number {
  if (secondsIntoNote < 0) return 0;
  const envelope = Math.exp(-secondsIntoNote * NOTE_DECAY_PER_SECOND);
  if (envelope < 0.001) return 0;
  return Math.sin(2 * Math.PI * frequencyHz * secondsIntoNote) * envelope;
}

/** The known reference waveform, at whatever rate the mixer is running. */
export function generateProbeReference(sampleRate: number): Int16Array {
  const totalSamples = Math.max(1, Math.round((sampleRate * PROBE_REFERENCE_MS) / 1000));
  const accumulator = new Float64Array(totalSamples);

  for (const note of PROBE_NOTES) {
    const startSample = Math.round((sampleRate * note.offsetMs) / 1000);
    for (let i = startSample; i < totalSamples; i += 1) {
      const seconds = (i - startSample) / sampleRate;
      const value = noteSample(seconds, note.frequencyHz) * note.gain;
      if (value === 0 && seconds > 0) break;
      accumulator[i] += value;
    }
  }

  const output = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i += 1) {
    const clamped = Math.max(-1, Math.min(1, accumulator[i]));
    output[i] = Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767);
  }
  return output;
}

/**
 * Extracts energy only at the three frequencies Relay itself emits.
 *
 * The previous detector reduced every 5 ms frame to broadband RMS. That threw
 * away the strongest discriminator in the probe: each note has a known pitch.
 * With a real song still playing, kick/snare/vocal energy could therefore hide
 * the restrained chime or create a stronger false envelope. Quadrature energy
 * is phase-insensitive like RMS but rejects most unrelated song energy.
 *
 * Features are interleaved by frame then note, so one correlation checks both
 * the irregular note timing and the C6/E6/G6 frequency sequence.
 */
function probeToneFeatures(samples: Int16Array, sampleRate: number): Float64Array {
  const { frameSamples, cos, sin } = probeToneBasis(sampleRate);
  const frameCount = Math.floor(samples.length / frameSamples);
  const channels = PROBE_NOTES.length;
  const features = new Float64Array(frameCount * channels);

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * frameSamples;

    for (let channel = 0; channel < channels; channel += 1) {
      const channelCos = cos[channel];
      const channelSin = sin[channel];
      let sumCos = 0;
      let sumSin = 0;

      for (let i = 0; i < frameSamples; i += 1) {
        const value = samples[start + i] / 32768;
        sumCos += value * channelCos[i];
        sumSin += value * channelSin[i];
      }

      features[frame * channels + channel] = Math.hypot(sumCos, sumSin) / frameSamples;
    }
  }

  return features;
}

type ProbeToneBasis = { frameSamples: number; cos: Float64Array[]; sin: Float64Array[] };
const probeToneBases = new Map<number, ProbeToneBasis>();
const probeReferenceFeatures = new Map<number, Float64Array>();

/**
 * Each feature frame measures its notes from phase zero, so one frame's worth
 * of cosine and sine per note serves every frame. `locateProbe` runs on the
 * mixer's thread, and evaluating them per sample cost it tens of milliseconds
 * of blocked mixing per probe leg; the table holds exactly the same values.
 */
function probeToneBasis(sampleRate: number): ProbeToneBasis {
  const cached = probeToneBases.get(sampleRate);
  if (cached) return cached;
  const frameSamples = Math.max(1, Math.round((sampleRate * FEATURE_FRAME_MS) / 1000));
  const cos: Float64Array[] = [];
  const sin: Float64Array[] = [];
  for (const note of PROBE_NOTES) {
    const channelCos = new Float64Array(frameSamples);
    const channelSin = new Float64Array(frameSamples);
    for (let i = 0; i < frameSamples; i += 1) {
      const phase = (2 * Math.PI * note.frequencyHz * i) / sampleRate;
      channelCos[i] = Math.cos(phase);
      channelSin[i] = Math.sin(phase);
    }
    cos.push(channelCos);
    sin.push(channelSin);
  }
  const basis = { frameSamples, cos, sin };
  probeToneBases.set(sampleRate, basis);
  return basis;
}

/** The reference never changes for a rate, so neither do its features. */
function probeReferenceToneFeatures(sampleRate: number) {
  const cached = probeReferenceFeatures.get(sampleRate);
  if (cached) return cached;
  const features = probeToneFeatures(generateProbeReference(sampleRate), sampleRate);
  probeReferenceFeatures.set(sampleRate, features);
  return features;
}

function normalizedCorrelation(a: Float64Array, aStart: number, b: Float64Array, length: number) {
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < length; i += 1) {
    sumA += a[aStart + i];
    sumB += b[i];
  }
  const meanA = sumA / length;
  const meanB = sumB / length;

  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < length; i += 1) {
    const x = a[aStart + i] - meanA;
    const y = b[i] - meanB;
    covariance += x * y;
    varianceA += x * x;
    varianceB += y * y;
  }

  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 1e-12 ? covariance / denominator : -1;
}

/**
 * Finds the reference inside a wider window of real microphone audio.
 * `micWindow` should be centred, as best guessed, on where the probe is
 * expected - this searches the whole window, so the guess only has to be
 * close enough that the true position falls inside it.
 */
export function locateProbe(micWindow: Int16Array, sampleRate: number): ProbeLocation {
  const micFeature = probeToneFeatures(micWindow, sampleRate);
  const refFeature = probeReferenceToneFeatures(sampleRate);
  const channels = PROBE_NOTES.length;
  const micFrames = Math.floor(micFeature.length / channels);
  const refFrames = Math.floor(refFeature.length / channels);

  let bestFrame = 0;
  let bestCorrelation = -1;
  for (let start = 0; start <= micFrames - refFrames; start += 1) {
    const correlation = normalizedCorrelation(
      micFeature,
      start * channels,
      refFeature,
      refFeature.length,
    );
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestFrame = start;
    }
  }

  const frameSamples = Math.max(1, Math.round((sampleRate * FEATURE_FRAME_MS) / 1000));
  return { offsetSamples: bestFrame * frameSamples, correlation: bestCorrelation };
}
