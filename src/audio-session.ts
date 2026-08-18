import { performance } from 'node:perf_hooks';

import type { PcmFrame } from './pcm-frame.js';

/**
 * Owns the live mix: both PCM timelines, the session clock, the alignment the
 * mixer applies, and the health counters that say when any of it is failing.
 *
 * This state used to be a dozen module-level variables in `server.ts`, which
 * meant transport events reached in and reset the mix clock directly. The
 * session is now told what happened - a source appeared, a frame arrived, an
 * alignment was measured - and decides for itself what that does to the audio.
 */

type PcmChunk = {
  start: number;
  samples: Int16Array;
  positioned: boolean;
};

type PcmTimeline = {
  chunks: PcmChunk[];
  /** Write frontier on the session timeline, not a count of samples received. */
  totalSamples: number;
  /** Capture session the current mapping was anchored to. */
  generation: number | null;
  /** sessionSample = streamSample + originOffset. */
  originOffset: number;
  /** Samples the timeline is missing: drops, congestion, transport outages. */
  gapSamples: number;
  unheadered: boolean;
};

export type AlignmentState = {
  /** RTT/2 fallback used until an acoustic calibration succeeds. */
  networkCompensationMs: number;
  calibratedMicLagMs: number | null;
  fineTuneMs: number;
};

/**
 * Raw evidence for exactly one mixed output frame.
 *
 * These values describe what the mixer actually read for the samples it just
 * emitted. They deliberately contain no Take verdict or policy: the audio
 * domain reports facts, while the Take domain decides whether those facts mean
 * clean, review or degraded.
 */
export type MixFrameEvidence = {
  micGapSamples: number;
  backingGapSamples: number;
  micStarvedSamples: number;
  backingStarvedSamples: number;
  micUnavailableSamples: number;
  backingUnavailableSamples: number;
  clippedSamples: number;
  limitedSamples: number;
  unheaderedSamples: number;
};

/** Authoritative position of one emitted frame on the shared mix timeline. */
export type MixFramePosition = {
  generation: number;
  firstSampleIndex: number;
};

export type MixHealth = {
  micStarvedFrames: number;
  backingStarvedFrames: number;
  micHeadroomMs: number;
  backingHeadroomMs: number;
  micGapMs: number;
  backingGapMs: number;
  /** Samples the summing stage had to clamp, i.e. audible distortion. */
  clippedSamples: number;
  /** Samples the microphone limiter held down. Working, not failing. */
  limitedSamples: number;
  /**
   * The raw microphone over the last few seconds, before any mix gain. Peak is
   * what decides the gain - it is what runs into the limiter - and RMS says
   * whether there is any signal at all. Null until the phone sends something.
   */
  micPeakDbfs: number | null;
  micRmsDbfs: number | null;
  unheadered: boolean;
};

/**
 * Jitter headroom the read-ahead is never allowed to eat. Reading ahead spends
 * prebuffer and reading behind spends retained history, so the advance has to
 * fit between them however large a lag the calibration reports.
 */
const ADVANCE_SAFETY_MS = 200;

/**
 * Peak limiter on the microphone, between its gain and the sum.
 *
 * One static gain cannot serve both ends of a voice: peaks run some 16 dB above
 * the average, so a gain set loud enough to hear clips on transients and a gain
 * set safe enough to never clip is inaudible. Every decibel between those is
 * the whole tuning range, and it moves whenever the singer does.
 *
 * A textbook feed-forward design: track the peak envelope, pull the gain down
 * quickly when it exceeds the threshold, let it back up slowly.
 *
 * The detector runs `LIMITER_LOOKAHEAD_MS` in front of the output, which is
 * normally bought by delaying the signal. Here it is free: the microphone is
 * read out of a buffer by index, so the limiter can simply look at samples the
 * mixer has not emitted yet. Nothing is delayed, so none of this moves the
 * alignment. Without it the first few milliseconds of every transient reach
 * the sum at full height before the envelope catches up.
 *
 * The final two-source sum also reserves fixed headroom. That keeps ordinary
 * voice + song peaks out of the hard clamp without adding a second dynamic
 * limiter that would pump the whole mix and change the singer/song balance.
 */
export const LIMITER_THRESHOLD_DBFS = -1;
const LIMITER_THRESHOLD = 10 ** (LIMITER_THRESHOLD_DBFS / 20);
const LIMITER_ATTACK_MS = 1.5;
const LIMITER_RELEASE_MS = 150;
const LIMITER_LOOKAHEAD_MS = 3;

/**
 * Worst-case linear sum after the microphone limiter plus the configured song
 * gain. A fixed attenuation preserves their relative balance and introduces no
 * attack/release artefacts.
 *
 * Only worth paying when both sources are actually present: it is headroom for
 * a sum, and a room with one source has nothing to sum. Charging it to a song
 * playing on its own made the song quieter to leave room for a voice that was
 * not there.
 */
function sumHeadroomGain(backingGain: number) {
  const maximumLinearSum = LIMITER_THRESHOLD + Math.abs(backingGain);
  return maximumLinearSum > 1 ? 1 / maximumLinearSum : 1;
}

/**
 * How long the song takes to duck out of a singer's way, and to come back.
 *
 * The song gain and the summing headroom both exist to leave room for a voice,
 * so both follow whether a microphone is expected. Switched instantly that is a
 * step of several dB in the middle of a song - plainly audible, and a worse
 * fault than the level it corrects. A microphone registers before any audio
 * flows, so this ramp is finished long before the first note.
 */
const SONG_DUCK_RAMP_MS = 150;

/**
 * How fast the raw microphone meter forgets. Long enough that a breath between
 * phrases does not read as a quiet microphone, short enough to follow a singer
 * moving nearer or further from the phone.
 */
const MIC_METER_HALF_LIFE_MS = 2_000;

/** Per-sample coefficient of a one-pole smoother with the given time constant. */
function onePoleCoefficient(timeConstantMs: number, sampleRate: number) {
  return 1 - Math.exp(-1 / ((timeConstantMs / 1000) * sampleRate));
}

/** Where a batch of ingested samples landed on the shared session timeline. */
export type IngestResult = {
  samples: Int16Array;
  /** Session sample index of the first sample, in mix-rate samples. */
  start: number;
};

export type AudioSessionOptions = {
  sampleRate: number;
  frameMs: number;
  prebufferMs: number;
  backingGain: number;
  /** How far behind the read head to keep microphone audio before discarding it. */
  retentionMs: number;
  /**
   * The same for the captured song, which the mixer reads at the read head
   * rather than behind it and so needs far less of - but it is not the only
   * reader. A probe calibration looks back over its whole search window, and
   * that window is minutes-old by timeline standards: it cannot be analysed
   * until enough audio has arrived to cover it.
   *
   * This was a hardcoded one second, which was enough only while the backing
   * path was two seconds slow and the probe therefore landed close to the
   * frontier. Bounding the capture latency moved the probe nearly two seconds
   * further back, straight into the discarded region, and the probe leg began
   * correlating at exactly -1 against a window of zeros.
   */
  backingRetentionMs?: number;
};

function emptyTimeline(): PcmTimeline {
  return {
    chunks: [],
    totalSamples: 0,
    generation: null,
    originOffset: 0,
    gapSamples: 0,
    unheadered: false,
  };
}

export class AudioSession {
  readonly sampleRate: number;
  readonly frameMs: number;
  readonly frameSamples: number;
  readonly prebufferMs: number;
  readonly retentionMs: number;
  readonly backingRetentionMs: number;

  private readonly backingGain: number;
  private readonly backingSumHeadroomGain: number;
  private readonly songDuckStep: number;
  /** 0 while the song has the room to itself, 1 once it is out of a voice's way. */
  private songDuck = 0;
  private readonly retentionSamples: number;
  private readonly backingRetentionSamples: number;

  private readonly mic = emptyTimeline();
  private readonly backing = emptyTimeline();

  private running = false;
  private startedAt = 0;
  private frameIndex = 0;
  private sessionGeneration = 0;

  private micExpected = false;
  private backingExpected = false;

  private micGainDb = 24;
  private alignmentState: AlignmentState = {
    networkCompensationMs: 0,
    calibratedMicLagMs: null,
    fineTuneMs: 0,
  };

  private micStarvedFrames = 0;
  private backingStarvedFrames = 0;
  private clippedSamples = 0;
  private limitedSamples = 0;

  // Envelope and gain reduction carry across frames; resetting them per frame
  // would put a 20 ms sawtooth on the vocal.
  private limiterEnvelope = 0;
  private limiterGain = 1;

  private micMeterPeak = 0;
  private micMeterPower = 0;
  private micMeterWeight = 0;
  private readonly limiterAttack: number;
  private readonly limiterRelease: number;
  private readonly limiterLookaheadSamples: number;
  private micHeadroomMs = 0;
  private backingHeadroomMs = 0;

  constructor(options: AudioSessionOptions) {
    this.sampleRate = options.sampleRate;
    this.frameMs = options.frameMs;
    this.frameSamples = Math.round((options.sampleRate * options.frameMs) / 1000);
    this.prebufferMs = options.prebufferMs;
    this.backingGain = options.backingGain;
    this.backingSumHeadroomGain = sumHeadroomGain(options.backingGain);
    this.songDuckStep = 1 / Math.max(
      1,
      Math.round((SONG_DUCK_RAMP_MS / 1000) * options.sampleRate),
    );
    this.retentionMs = options.retentionMs;
    this.retentionSamples = Math.round((options.retentionMs * options.sampleRate) / 1000);
    this.backingRetentionMs = options.backingRetentionMs ?? 1_000;
    this.backingRetentionSamples = Math.round((this.backingRetentionMs * options.sampleRate) / 1000);
    this.limiterAttack = onePoleCoefficient(LIMITER_ATTACK_MS, options.sampleRate);
    this.limiterRelease = onePoleCoefficient(LIMITER_RELEASE_MS, options.sampleRate);
    this.limiterLookaheadSamples = Math.round((LIMITER_LOOKAHEAD_MS * options.sampleRate) / 1000);
  }

  get active() {
    return this.running;
  }

  /** Increments whenever the mix clock restarts; alignment is scoped to it. */
  get generation() {
    return this.sessionGeneration;
  }

  /** Capture session of the microphone stream currently on the timeline. */
  get micGeneration() {
    return this.mic.generation;
  }

  /** Capture session of the captured-song stream currently on the timeline. */
  get backingGeneration() {
    return this.backing.generation;
  }

  /**
   * How far the microphone timeline actually reaches. `readMic` pads anything
   * past this with zeros, so a reader that needs real audio - rather than a
   * best effort - has to wait for this to pass the end of its range.
   */
  get micTotalSamples() {
    return this.mic.totalSamples;
  }

  /** The same frontier for the captured song. See `micTotalSamples`. */
  get backingTotalSamples() {
    return this.backing.totalSamples;
  }

  start(nowMs = performance.now()) {
    this.running = true;
    this.resetEpoch(nowMs);
  }

  stop() {
    this.running = false;
    this.alignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
    this.resetHealth();
  }

  /**
   * Restarts the mix clock. Both timelines must be cleared together or their
   * indices stop describing the same moment.
   */
  resetEpoch(nowMs = performance.now()) {
    this.startedAt = nowMs;
    this.frameIndex = 0;
    this.sessionGeneration += 1;
    this.clearTimeline(this.mic);
    this.clearTimeline(this.backing);
    // A new session starts from what the room currently is, not from wherever
    // the previous one's ramp happened to stop.
    this.songDuck = this.backingExpected && this.micExpected ? 1 : 0;
    this.resetHealth();
  }

  /**
   * Whether a source is meant to be streaming. Starvation is only meaningful
   * for a source that is supposed to be there; an absent phone is not a fault.
   */
  setMicExpected(expected: boolean) {
    this.micExpected = expected;
  }

  setBackingExpected(expected: boolean) {
    this.backingExpected = expected;
  }

  setMicGainDb(value: number) {
    this.micGainDb = value;
  }

  get alignment(): AlignmentState {
    return { ...this.alignmentState };
  }

  setAlignment(patch: Partial<AlignmentState>) {
    this.alignmentState = { ...this.alignmentState, ...patch };
  }

  /** What the alignment asks for, before the buffer's limits are applied. */
  get requestedMicAdvanceMs() {
    const base = this.alignmentState.calibratedMicLagMs ?? this.alignmentState.networkCompensationMs;
    return base - this.alignmentState.fineTuneMs;
  }

  /**
   * Milliseconds the mixer actually reads ahead in the microphone timeline.
   *
   * A measurement larger than the buffers can absorb is clamped rather than
   * obeyed: obeying it reads past the end of the microphone history and the
   * vocal disappears entirely, where clamping leaves it audible but late. Both
   * are wrong, and only one of them can be heard and diagnosed. The difference
   * from `requestedMicAdvanceMs` is what says the buffer is too small.
   */
  get appliedMicAdvanceMs() {
    // Never past zero in either direction: a buffer too small to afford any
    // read-ahead means no read-ahead, not a shove the other way.
    const ahead = Math.max(0, this.prebufferMs - ADVANCE_SAFETY_MS);
    const behind = Math.max(0, this.retentionMs - ADVANCE_SAFETY_MS);
    return Math.max(-behind, Math.min(ahead, this.requestedMicAdvanceMs));
  }

  ingestMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    const result = this.ingest(this.mic, frame, sourceRate, nowMs);
    this.meterMic(result.samples);
    return result;
  }

  ingestBacking(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    return this.ingest(this.backing, frame, sourceRate, nowMs);
  }

  /** Exposed for the click diagnostic, which mixes against the microphone. */
  readMic(startSample: number, count: number) {
    return this.readRange(this.mic, startSample, count);
  }

  /** The same window into the captured song, for locating a probe in it. */
  readBacking(startSample: number, count: number) {
    return this.readRange(this.backing, startSample, count);
  }

  /**
   * Session-sample coordinate for a real-world instant, independent of
   * either timeline's own anchor. A probe calibration schedules playback
   * against a client clock mapped onto this, then finds where it actually
   * landed in the (possibly mis-anchored) mic timeline via correlation - the
   * discrepancy between the two is exactly the anchor bias `calibratedMicLagMs`
   * exists to correct.
   */
  sessionSampleAt(nowMs: number) {
    return this.currentSessionSample(nowMs);
  }

  trimMic(beforeSample: number) {
    this.trim(this.mic, beforeSample);
  }

  clearMic() {
    this.clearTimeline(this.mic);
  }

  /** Emits every frame whose time has come. Returns how many were produced. */
  drain(
    emit: (frame: Buffer, evidence: MixFrameEvidence, position: MixFramePosition) => void,
    nowMs = performance.now(),
    maxFrames = 5,
  ) {
    if (!this.running) return 0;

    const elapsed = nowMs - this.startedAt - this.prebufferMs;
    if (elapsed < 0) return 0;

    const expected = Math.floor(elapsed / this.frameMs) + 1;
    let remaining = Math.min(maxFrames, expected - this.frameIndex);
    let sent = 0;

    while (remaining > 0) {
      const mixed = this.mixFrame(this.frameIndex);
      emit(mixed.frame, mixed.evidence, {
        generation: this.sessionGeneration,
        firstSampleIndex: this.frameIndex * this.frameSamples,
      });
      this.frameIndex += 1;
      remaining -= 1;
      sent += 1;
    }

    return sent;
  }

  health(): MixHealth {
    return {
      micStarvedFrames: this.micStarvedFrames,
      backingStarvedFrames: this.backingStarvedFrames,
      micHeadroomMs: Math.round(this.micHeadroomMs),
      backingHeadroomMs: Math.round(this.backingHeadroomMs),
      micGapMs: Math.round((this.mic.gapSamples / this.sampleRate) * 1000),
      backingGapMs: Math.round((this.backing.gapSamples / this.sampleRate) * 1000),
      clippedSamples: this.clippedSamples,
      limitedSamples: this.limitedSamples,
      micPeakDbfs: this.micMeterPeak > 0 ? 20 * Math.log10(this.micMeterPeak) : null,
      micRmsDbfs: this.micMeterWeight > 0 && this.micMeterPower > 0
        ? 20 * Math.log10(Math.sqrt(this.micMeterPower / this.micMeterWeight))
        : null,
      unheadered: this.mic.unheadered || this.backing.unheadered,
    };
  }

  resetHealth() {
    this.micStarvedFrames = 0;
    this.backingStarvedFrames = 0;
    this.clippedSamples = 0;
    this.limitedSamples = 0;
    this.micMeterPeak = 0;
    this.micMeterPower = 0;
    this.micMeterWeight = 0;
    this.micHeadroomMs = 0;
    this.backingHeadroomMs = 0;
    // These are audio state, not just diagnostics. Carrying gain reduction into
    // a new epoch makes the beginning of the next take inherit the previous
    // singer's last transient and can attenuate it for hundreds of milliseconds.
    this.limiterEnvelope = 0;
    this.limiterGain = 1;
    this.mic.gapSamples = 0;
    this.backing.gapSamples = 0;
  }

  // ---------------------------------------------------------------- internals

  private clearTimeline(timeline: PcmTimeline) {
    timeline.chunks = [];
    timeline.totalSamples = 0;
    timeline.generation = null;
    timeline.originOffset = 0;
    timeline.gapSamples = 0;
    timeline.unheadered = false;
  }

  /** Where the session clock is now, in session samples since the epoch. */
  private currentSessionSample(nowMs = performance.now()) {
    return Math.round(((nowMs - this.startedAt) * this.sampleRate) / 1000);
  }

  private ingest(timeline: PcmTimeline, frame: PcmFrame, sourceRate: number | null, nowMs: number): IngestResult {
    if (!sourceRate) return { samples: new Int16Array(0), start: timeline.totalSamples };
    let samples = this.resample(frame.pcm, sourceRate);
    if (samples.length === 0) return { samples, start: timeline.totalSamples };

    let start: number;
    const positioned = frame.firstSampleIndex !== null;

    if (!positioned) {
      // No header: the only thing left to do is append at the frontier, which
      // is the old lossy behaviour. Flag it so the UI can say the client is
      // stale rather than letting it degrade invisibly.
      timeline.unheadered = true;
      start = timeline.totalSamples;
    } else {
      // Each frame states its own position, so rounding never accumulates and a
      // missing frame leaves a hole of exactly the right length instead of
      // pulling everything after it earlier.
      const streamStart = Math.round((frame.firstSampleIndex! * this.sampleRate) / sourceRate);

      if (timeline.generation !== frame.generation) {
        // A fresh capture session. Anchor it to the session clock; the previous
        // session's samples keep their own place and simply age out.
        timeline.generation = frame.generation;
        timeline.originOffset = Math.max(0, this.currentSessionSample(nowMs) - samples.length) - streamStart;
      }

      start = streamStart + timeline.originOffset;
    }

    if (start < timeline.totalSamples) {
      // Transport ordering is no longer an AudioSession contract. The packet
      // receiver normally prevents late overlap, but this boundary still must
      // not relocate old audio to "now" if a caller violates it. Keep only a
      // genuinely new tail; a fully late packet contributes nothing.
      const overlap = timeline.totalSamples - start;
      if (overlap >= samples.length) {
        return { samples: new Int16Array(0), start: timeline.totalSamples };
      }
      samples = samples.slice(overlap);
      start = timeline.totalSamples;
    } else if (start > timeline.totalSamples && timeline.chunks.length > 0) {
      timeline.gapSamples += start - timeline.totalSamples;
    }

    if (samples.length === 0) return { samples, start };
    timeline.chunks.push({ start, samples, positioned });
    timeline.totalSamples = start + samples.length;
    return { samples, start };
  }

  private resample(buffer: Buffer, sourceRate: number) {
    const inputLength = Math.floor(buffer.byteLength / 2);
    if (inputLength <= 0) return new Int16Array(0);
    if (sourceRate === this.sampleRate) {
      const output = new Int16Array(inputLength);
      for (let i = 0; i < inputLength; i += 1) output[i] = buffer.readInt16LE(i * 2);
      return output;
    }

    const outputLength = Math.max(1, Math.round((inputLength * this.sampleRate) / sourceRate));
    const output = new Int16Array(outputLength);
    const ratio = sourceRate / this.sampleRate;

    const readSample = (index: number) => {
      const bounded = Math.max(0, Math.min(inputLength - 1, index));
      return buffer.readInt16LE(bounded * 2);
    };

    for (let i = 0; i < outputLength; i += 1) {
      const position = i * ratio;
      const index = Math.floor(position);
      const fraction = position - index;
      const a = readSample(index);
      const b = readSample(index + 1);
      output[i] = Math.round(a + (b - a) * fraction);
    }

    return output;
  }

  private firstChunkAtOrBefore(timeline: PcmTimeline, sampleIndex: number) {
    let low = 0;
    let high = timeline.chunks.length - 1;
    let result = 0;

    while (low <= high) {
      const mid = (low + high) >> 1;
      if (timeline.chunks[mid].start <= sampleIndex) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    return result;
  }

  private readRange(timeline: PcmTimeline, startSample: number, count: number) {
    const output = new Int16Array(count);
    if (timeline.chunks.length === 0) return output;

    let outputOffset = 0;
    let cursor = startSample;

    if (cursor < 0) {
      const silence = Math.min(count, -cursor);
      outputOffset += silence;
      cursor += silence;
    }

    if (outputOffset >= count || cursor >= timeline.totalSamples) return output;

    let chunkIndex = this.firstChunkAtOrBefore(timeline, cursor);
    while (chunkIndex < timeline.chunks.length && outputOffset < count) {
      const chunk = timeline.chunks[chunkIndex];
      const chunkEnd = chunk.start + chunk.samples.length;

      if (cursor >= chunkEnd) {
        chunkIndex += 1;
        continue;
      }

      // A hole in the timeline reads as the silence that actually happened.
      if (cursor < chunk.start) {
        const silence = Math.min(count - outputOffset, chunk.start - cursor);
        outputOffset += silence;
        cursor += silence;
        continue;
      }

      const sourceOffset = cursor - chunk.start;
      const available = chunk.samples.length - sourceOffset;
      const copyCount = Math.min(count - outputOffset, available);
      output.set(chunk.samples.subarray(sourceOffset, sourceOffset + copyCount), outputOffset);
      outputOffset += copyCount;
      cursor += copyCount;
      chunkIndex += 1;
    }

    return output;
  }

  /**
   * Describes missing/legacy source samples for exactly the requested output
   * range. Silence before session sample zero is structural pre-roll and is not
   * counted as a source failure. Missing samples inside an established frontier
   * are gaps; samples beyond the frontier are starvation/unavailability.
   */
  private readEvidence(timeline: PcmTimeline, startSample: number, count: number) {
    let cursor = startSample;
    let remaining = count;
    let gapSamples = 0;
    let frontierMissingSamples = 0;
    let unheaderedSamples = 0;

    if (remaining <= 0) return { gapSamples, frontierMissingSamples, unheaderedSamples };
    if (cursor < 0) {
      const preRoll = Math.min(remaining, -cursor);
      cursor += preRoll;
      remaining -= preRoll;
    }
    if (remaining <= 0) return { gapSamples, frontierMissingSamples, unheaderedSamples };

    if (timeline.chunks.length === 0 || cursor >= timeline.totalSamples) {
      frontierMissingSamples += remaining;
      return { gapSamples, frontierMissingSamples, unheaderedSamples };
    }

    let chunkIndex = this.firstChunkAtOrBefore(timeline, cursor);
    while (remaining > 0) {
      if (cursor >= timeline.totalSamples || chunkIndex >= timeline.chunks.length) {
        frontierMissingSamples += remaining;
        break;
      }

      const chunk = timeline.chunks[chunkIndex];
      const chunkEnd = chunk.start + chunk.samples.length;
      if (cursor >= chunkEnd) {
        chunkIndex += 1;
        continue;
      }

      if (cursor < chunk.start) {
        const missing = Math.min(remaining, chunk.start - cursor);
        gapSamples += missing;
        cursor += missing;
        remaining -= missing;
        continue;
      }

      const available = Math.min(remaining, chunkEnd - cursor);
      if (!chunk.positioned) unheaderedSamples += available;
      cursor += available;
      remaining -= available;
      chunkIndex += 1;
    }

    return { gapSamples, frontierMissingSamples, unheaderedSamples };
  }

  private trim(timeline: PcmTimeline, beforeSample: number) {
    while (timeline.chunks.length > 1) {
      const chunk = timeline.chunks[0];
      if (chunk.start + chunk.samples.length >= beforeSample) break;
      timeline.chunks.shift();
    }
  }

  /**
   * Tracks the raw microphone so the gain can be set from what the phone is
   * actually sending. This has to watch the live stream: the only other
   * measurement of the microphone happens during calibration, where the singer
   * is asked to stay quiet, so it describes the room rather than the voice.
   */
  private meterMic(samples: Int16Array) {
    if (samples.length === 0) return;

    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < samples.length; i += 1) {
      const value = samples[i] / 32768;
      sumSquares += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
    }

    // One decay step per batch, sized by the time the batch covers, so the
    // meter reads the same however the frames happen to be chunked.
    const keep = 2 ** (-((samples.length / this.sampleRate) * 1000) / MIC_METER_HALF_LIFE_MS);

    this.micMeterPeak = Math.max(peak, this.micMeterPeak * keep);
    this.micMeterPower = sumSquares / samples.length + this.micMeterPower * keep;
    this.micMeterWeight = 1 + this.micMeterWeight * keep;
  }

  /**
   * One sample through the peak limiter. `detect` is the sample the detector
   * should react to - a few milliseconds ahead of `value` - so the reduction is
   * already in place when the peak arrives.
   */
  private limit(value: number, detect: number) {
    const magnitude = Math.abs(detect);
    // Peak-hold: the envelope takes a new peak immediately and only decays
    // slowly. Smoothing the rise here as well would put two lags in series and
    // the gain would still be falling when the peak arrived, which is what the
    // look-ahead exists to prevent. The single lag left is the gain itself.
    this.limiterEnvelope = magnitude > this.limiterEnvelope
      ? magnitude
      : this.limiterEnvelope + (magnitude - this.limiterEnvelope) * this.limiterRelease;

    const target = this.limiterEnvelope > LIMITER_THRESHOLD
      ? LIMITER_THRESHOLD / this.limiterEnvelope
      : 1;
    // Gain reduction engages at the attack rate and recovers at the release
    // rate; smoothing it is what keeps the reduction from sounding like a click.
    this.limiterGain += (target - this.limiterGain)
      * (target < this.limiterGain ? this.limiterAttack : this.limiterRelease);

    if (this.limiterGain < 0.99) this.limitedSamples += 1;
    return value * this.limiterGain;
  }

  private mixFrame(frameIndex: number): { frame: Buffer; evidence: MixFrameEvidence } {
    const startSample = frameIndex * this.frameSamples;
    const advanceSamples = Math.round((this.appliedMicAdvanceMs * this.sampleRate) / 1000);
    const micReadStart = startSample + advanceSamples;

    // Reading ahead can outrun what has actually arrived. readRange pads with
    // zeros when that happens, so without this the vocal simply disappears in
    // chunks and nothing anywhere says why.
    // The limiter's look-ahead reads past the frame, so it is part of what has
    // to have arrived for this frame to be complete.
    const micReadEnd = micReadStart + this.frameSamples + this.limiterLookaheadSamples;
    this.micHeadroomMs = ((this.mic.totalSamples - micReadEnd) / this.sampleRate) * 1000;
    this.backingHeadroomMs = ((this.backing.totalSamples - (startSample + this.frameSamples)) / this.sampleRate) * 1000;
    if (this.micHeadroomMs < 0 && this.micExpected) this.micStarvedFrames += 1;
    if (this.backingHeadroomMs < 0 && this.backingExpected) this.backingStarvedFrames += 1;

    // Take evidence is scoped only to source samples that feed this emitted
    // frame. In particular, the limiter look-ahead may be short without a single
    // emitted vocal sample being missing, so it is deliberately excluded here.
    const micReadEvidence = this.readEvidence(this.mic, micReadStart, this.frameSamples);
    const backingReadEvidence = this.readEvidence(this.backing, startSample, this.frameSamples);
    const clippedBefore = this.clippedSamples;
    const limitedBefore = this.limitedSamples;

    // The extra tail is the limiter's look-ahead, not audio to be emitted.
    const lookahead = this.limiterLookaheadSamples;
    const mic = this.readRange(this.mic, micReadStart, this.frameSamples + lookahead);
    const song = this.readRange(this.backing, startSample, this.frameSamples);
    const micGain = 10 ** (this.micGainDb / 20);
    // `backingExpected` and `micExpected` are the room's semantic signals for
    // which sources this mix has. Both must hold: the reservation is headroom
    // for a sum, so a room with only one source has nothing to reserve against.
    // Do not attenuate voice-only rooms merely because a stale backing timeline
    // still exists from an earlier route, and do not quieten a song playing on
    // its own to leave room for a voice nobody is singing.
    // `backingExpected` and `micExpected` are the room's semantic signals for
    // which sources this mix has. The song gain and the summing headroom both
    // exist to leave space for a voice, so both are worth paying only when a
    // voice can actually arrive: a song playing to a room where nobody has
    // taken the microphone was being quietened for a singer who was not there,
    // and the balance a real performance was tuned against is unchanged.
    const duckTarget = this.backingExpected && this.micExpected ? 1 : 0;
    const output = Buffer.allocUnsafe(this.frameSamples * 2);

    for (let i = 0; i < this.frameSamples; i += 1) {
      // Ramped per sample: the room can gain or lose a microphone mid-song, and
      // several dB arriving in one sample is a click.
      if (this.songDuck < duckTarget) {
        this.songDuck = Math.min(duckTarget, this.songDuck + this.songDuckStep);
      } else if (this.songDuck > duckTarget) {
        this.songDuck = Math.max(duckTarget, this.songDuck - this.songDuckStep);
      }
      const songGain = 1 + this.songDuck * (this.backingGain - 1);
      const mixHeadroomGain = 1 + this.songDuck * (this.backingSumHeadroomGain - 1);

      const voice = this.limit((mic[i] / 32768) * micGain, (mic[i + lookahead] / 32768) * micGain);
      const summed = voice + (song[i] / 32768) * songGain;
      const value = summed * mixHeadroomGain;
      // Normal two-source peaks have already had deterministic summing headroom
      // reserved. Keep this clamp as an invariant/backstop for unexpected future
      // inputs or limiter overshoot, and keep counting it as audible distortion.
      if (value > 1 || value < -1) this.clippedSamples += 1;
      const clamped = Math.max(-1, Math.min(1, value));
      output.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
    }

    const evidence: MixFrameEvidence = {
      micGapSamples: micReadEvidence.gapSamples,
      backingGapSamples: backingReadEvidence.gapSamples,
      micStarvedSamples: this.micExpected ? micReadEvidence.frontierMissingSamples : 0,
      backingStarvedSamples: this.backingExpected ? backingReadEvidence.frontierMissingSamples : 0,
      micUnavailableSamples: this.micExpected ? 0 : micReadEvidence.frontierMissingSamples,
      backingUnavailableSamples: this.backingExpected ? 0 : backingReadEvidence.frontierMissingSamples,
      clippedSamples: this.clippedSamples - clippedBefore,
      limitedSamples: this.limitedSamples - limitedBefore,
      unheaderedSamples: micReadEvidence.unheaderedSamples + backingReadEvidence.unheaderedSamples,
    };

    this.trim(this.mic, startSample - this.retentionSamples);
    this.trim(this.backing, startSample - this.backingRetentionSamples);
    return { frame: output, evidence };
  }
}
