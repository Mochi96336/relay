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
  /** Source sample rate that gives this capture generation's indices their units. */
  sourceRate: number | null;
  /** sessionSample = streamSample + originOffset. */
  originOffset: number;
  /** Samples the timeline is missing: drops, congestion, transport outages. */
  gapSamples: number;
  unheadered: boolean;
  /** Smoothed difference between this source clock and the mix clock. */
  clockErrorSamples: number;
  /** Raw source frontier used to distinguish clock drift from real packet gaps. */
  sourceFrontier: number | null;
  /** Samples inserted to keep a slower continuous local source on time. */
  clockCorrectionSamples: number;
  /**
   * Last raw source sample from the furthest accepted positioned packet.
   * A phase-correct resampler may need this one sample when the next transport
   * packet begins between two target-rate sample positions.
   */
  resampleTailSample: number | null;
  /**
   * Next absolute mix-rate sample on the source clock that still needs to be
   * emitted. Upsampling may defer one target sample until the following source
   * packet supplies the interpolation endpoint.
   */
  resampleNextTargetSample: number | null;
};

/**
 * Lengthen a proven-contiguous PCM span by exactly one sample without creating
 * a zero-order hold at the frame tail.
 *
 * The endpoints are preserved and the added time is distributed across the
 * whole span with linear interpolation. This is a tiny sample-rate trim, not a
 * content splice.
 */
function stretchPcmSpanByOne(input: Int16Array) {
  if (input.length === 0) return new Int16Array(0);
  if (input.length === 1) return Int16Array.of(input[0], input[0]);

  const output = new Int16Array(input.length + 1);
  const sourceScale = (input.length - 1) / input.length;
  for (let index = 0; index < output.length; index += 1) {
    const position = index * sourceScale;
    const left = Math.floor(position);
    const fraction = position - left;
    const a = input[left];
    const b = input[Math.min(left + 1, input.length - 1)];
    output[index] = Math.round(a + (b - a) * fraction);
  }
  return output;
}

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
  backingClockCorrectionSamples: number;
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
 * A sound device and `performance.now()` are independent clocks. Even a tiny
 * parts-per-million difference eventually consumes the whole live buffer when
 * a Robot source runs for hours. Smooth arrival phase over roughly ten seconds
 * and correct a source deficit only beyond a two-millisecond deadband, at no
 * more than one sample per input frame. A source legitimately buffered ahead
 * is left untouched. This is an inaudible sample-rate trim, not a jump in the
 * Song timeline.
 */
const BACKING_CLOCK_ERROR_ALPHA = 0.002;
const BACKING_CLOCK_DEADBAND_MS = 2;

/**
 * Runtime validation corrects an already-live read head. Moving it in one frame
 * skips or repeats the whole delta, so validated drift is allowed to change the
 * read rate by at most one percent until the new target is reached. Initial,
 * manual and robot calibrations still use the existing immediate setAlignment.
 */
const RUNTIME_CALIBRATION_SLEW_FRACTION = 0.01;

/**
 * Immediate authority changes must take effect immediately, but changing the
 * Mic read head by tens or hundreds of milliseconds in one sample is a splice.
 * Fade from the previously-emitted trajectory into the new one over only a few
 * milliseconds: long enough to remove the discontinuity, short enough that the
 * timing authority is not audibly delayed.
 */
const MIC_READ_HEAD_CROSSFADE_MS = 5;

/**
 * A real packet hole is silence, but entering or leaving that silence in one
 * sample creates a click that was not present in either source segment.
 * Preserve the hole itself and its evidence; taper only the real source
 * samples immediately adjacent to it.
 */
const SOURCE_GAP_DECLICK_MS = 2;

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
 * Live Mic gain is user-controlled and may change while voiced audio is
 * non-zero. Apply a short perceptual (dB-domain) ramp instead of stepping the
 * multiplier at a 20 ms frame boundary.
 */
const MIC_GAIN_RAMP_MS = 20;

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
  /** An established capture clock was replaced before this batch was placed. */
  captureRestarted: boolean;
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
    sourceRate: null,
    originOffset: 0,
    gapSamples: 0,
    unheadered: false,
    clockErrorSamples: 0,
    sourceFrontier: null,
    clockCorrectionSamples: 0,
    resampleTailSample: null,
    resampleNextTargetSample: null,
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

  private micGainDbValue = 24;
  /** Gain actually applied to the current emitted sample. */
  private micGainDbApplied = 24;
  private micGainRampRemainingSamples = 0;
  private readonly micGainRampSamples: number;
  private alignmentState: AlignmentState = {
    networkCompensationMs: 0,
    calibratedMicLagMs: null,
    fineTuneMs: 0,
  };
  /** Desired live drift correction while the currently applied lag slews there. */
  private calibratedMicLagTargetMs: number | null = null;
  /**
   * Actual Mic advance trajectory emitted at the end of the previous frame.
   * This is deliberately separate from alignmentState: an immediate authority
   * update can replace alignmentState between frames, but continuity still has
   * to know where the audible read head came from.
   */
  private lastEmittedMicAdvanceSamples: number | null = null;
  /** Whether the preceding emitted Mic frame was backed by real source PCM. */
  private lastEmittedMicFrameComplete = false;
  /** Last per-source contributions that actually reached the mix output. */
  private lastEmittedMicContribution = 0;
  private lastEmittedBackingContribution = 0;
  /** Bounded output-edge taper after bind-time capture retirement. */
  private micRetirementFadeStart = 0;
  private micRetirementFadeRemainingSamples = 0;
  private backingRetirementFadeStart = 0;
  private backingRetirementFadeRemainingSamples = 0;
  /** The replacement capture's first audible contribution must enter from silence. */
  private micReplacementNeedsFadeIn = false;
  private backingReplacementNeedsFadeIn = false;
  private micReplacementFadeInRemainingSamples = 0;
  private backingReplacementFadeInRemainingSamples = 0;
  /**
   * In-band capture-clock restarts cannot retire queued old PCM at ingest time.
   * Keep every unread old-capture frontier in order: more than one restart can
   * arrive before the mix read head reaches the first boundary.
   */
  private readonly micCaptureRestartBoundarySamples: number[] = [];
  private readonly backingCaptureRestartBoundarySamples: number[] = [];
  /**
   * Mixer-output frontier continuity.
   *
   * A timeline can be perfectly contiguous once late PCM arrives even though an
   * earlier mix frame already exhausted the then-known frontier and emitted
   * silence. Track that audible state separately from raw timeline evidence so
   * starvation/recovery can be de-clicked without rewriting source history.
   */
  private micFrontierOutputMissing = false;
  private backingFrontierOutputMissing = false;
  private micFrontierFadeStart = 0;
  private backingFrontierFadeStart = 0;
  private micFrontierFadeRemainingSamples = 0;
  private backingFrontierFadeRemainingSamples = 0;
  private micFrontierRecoveryFadeRemainingSamples = 0;
  private backingFrontierRecoveryFadeRemainingSamples = 0;
  private readonly sourceEdgeFadeSamples: number;

  private micStarvedFrames = 0;
  private backingStarvedFrames = 0;
  /** Consecutive emitted frames missing real source samples, whether a gap or frontier starvation. */
  private micUnplayableRunFrames = 0;
  private backingUnplayableRunFrames = 0;
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
  /** Samples the read head is held back to stay inside arrived microphone audio. */
  private micFrontierCorrectionSamples = 0;
  private micFrontierAtLastFrame = 0;
  /** Consecutive mixed frames in which no new microphone audio arrived. */
  private micFrontierIdleFrames = 0;
  /**
   * Bounded settling window after a truly stalled frontier starts moving again.
   * A queued stale packet must not instantly redefine seconds of outage as live
   * latency, but a genuinely steady late stream must regain frontier correction.
   */
  private micFrontierResumeGuardFrames = 0;
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
    this.micGainRampSamples = Math.max(
      1,
      Math.round((MIC_GAIN_RAMP_MS / 1000) * options.sampleRate),
    );
    this.sourceEdgeFadeSamples = Math.max(
      1,
      Math.round((SOURCE_GAP_DECLICK_MS * options.sampleRate) / 1000),
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

  /**
   * Whether the mixer has emitted complete real source frames within the same
   * safety window used for Mic frontier recovery.
   *
   * Transport freshness is deliberately separate: a socket can be receiving a
   * burst of stale backlog while the current mix frame is still silence.
   */
  get micPlayable() {
    return this.micUnplayableRunFrames <= Math.ceil(ADVANCE_SAFETY_MS / this.frameMs);
  }

  get backingPlayable() {
    return this.backingUnplayableRunFrames <= Math.ceil(ADVANCE_SAFETY_MS / this.frameMs);
  }

  /**
   * Classifies a metadata-capable Backing registration against the capture
   * clock already retained by this mix. A reconnect may be ahead because the
   * sender keeps its source clock running while transport is down; only a
   * rewind, generation change or source-rate change proves replacement.
   */
  backingCaptureReplacedBy(input: {
    generation: number;
    sourceRate: number;
    sampleCursor: number;
  }) {
    const established = this.backing.totalSamples > 0
      || this.backing.generation !== null
      || this.backing.sourceRate !== null
      || this.backing.sourceFrontier !== null;
    if (!established) return false;

    return this.backing.generation !== input.generation
      || this.backing.sourceRate !== input.sourceRate
      || this.backing.sourceFrontier === null
      || input.sampleCursor < this.backing.sourceFrontier;
  }

  start(nowMs = performance.now()) {
    this.running = true;
    this.resetEpoch(nowMs);
  }

  stop() {
    this.running = false;
    this.alignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
    this.calibratedMicLagTargetMs = null;
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
    // The frontier correction described the old timelines' positions.
    this.resetMicFrontierTracking();
    // A pending correction belongs to the old mix epoch. Preserve the value
    // already being applied but do not continue walking an old target forward.
    this.calibratedMicLagTargetMs = this.alignmentState.calibratedMicLagMs;
    // A new session starts from what the room currently is, not from wherever
    // the previous one's ramp happened to stop.
    this.songDuck = this.backingExpected && this.micExpected ? 1 : 0;
    this.micGainDbApplied = this.micGainDbValue;
    this.micGainRampRemainingSamples = 0;
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

  get micGainDb() {
    return this.micGainDbValue;
  }

  setMicGainDb(value: number) {
    const changed = value !== this.micGainDbValue;
    this.micGainDbValue = value;
    if (!this.running) {
      this.micGainDbApplied = value;
      this.micGainRampRemainingSamples = 0;
    } else if (changed) {
      // Restart from the gain that is actually audible now. If a later command
      // arrives before a longer-than-frame test configuration has settled, it
      // bends from the current trajectory instead of jumping to either target.
      this.micGainRampRemainingSamples = this.micGainRampSamples;
    }
  }

  get alignment(): AlignmentState {
    return { ...this.alignmentState };
  }

  /** Current target, equal to the applied lag when no runtime slew is pending. */
  get calibratedMicLagTarget() {
    return this.calibratedMicLagTargetMs;
  }

  /** Immediate authority change used by existing initial/manual/robot semantics. */
  setAlignment(patch: Partial<AlignmentState>) {
    this.alignmentState = { ...this.alignmentState, ...patch };
    if (Object.prototype.hasOwnProperty.call(patch, 'calibratedMicLagMs')) {
      this.calibratedMicLagTargetMs = patch.calibratedMicLagMs ?? null;
    }
  }

  /**
   * Changes only the target. `mixFrame` advances the applied read head gradually
   * so live validation cannot skip/repeat the full correction in one frame.
   */
  slewCalibratedMicLagTo(targetMs: number) {
    if (!Number.isFinite(targetMs)) return false;
    const current = this.alignmentState.calibratedMicLagMs;
    if (current === null || !this.running) {
      const changed = current !== targetMs || this.calibratedMicLagTargetMs !== targetMs;
      this.setAlignment({ calibratedMicLagMs: targetMs });
      return changed;
    }
    if (this.calibratedMicLagTargetMs === targetMs) return false;
    this.calibratedMicLagTargetMs = targetMs;
    return true;
  }

  /** What the alignment asks for, before the buffer's limits are applied. */
  get requestedMicAdvanceMs() {
    const base = this.alignmentState.calibratedMicLagMs ?? this.alignmentState.networkCompensationMs;
    return base - this.alignmentState.fineTuneMs;
  }

  /** What the configured buffers can afford, before the live frontier is known. */
  private budgetedMicAdvanceMs(requestedMicAdvanceMs = this.requestedMicAdvanceMs) {
    // Never past zero in either direction: a buffer too small to afford any
    // read-ahead means no read-ahead, not a shove the other way.
    const ahead = Math.max(0, this.prebufferMs - ADVANCE_SAFETY_MS);
    const behind = Math.max(0, this.retentionMs - ADVANCE_SAFETY_MS);
    return Math.max(-behind, Math.min(ahead, requestedMicAdvanceMs));
  }

  /** How far back the retained microphone history allows the read head to sit. */
  private maximumMicReadBehindMs() {
    return Math.max(0, this.retentionMs - ADVANCE_SAFETY_MS);
  }

  /**
   * Milliseconds the mixer actually reads ahead in the microphone timeline.
   *
   * A measurement larger than the buffers can absorb is clamped rather than
   * obeyed: obeying it reads past the end of the microphone history and the
   * vocal disappears entirely, where clamping leaves it audible but late. Both
   * are wrong, and only one of them can be heard and diagnosed. The difference
   * from `requestedMicAdvanceMs` is what says the buffer is too small.
   *
   * The buffer budget alone is not enough to keep that promise. It assumes the
   * microphone timeline runs ahead of the mix clock by roughly the prebuffer,
   * and a capture that joined late or never caught up breaks that assumption:
   * the read head then lands past everything that has arrived, `readRange` pads
   * the frame with zeros, and because both timelines advance at the mix rate
   * afterwards the deficit is constant. Nothing closes it, so a single
   * alignment change silences the microphone for as long as the room stays up.
   * `micFrontierCorrectionSamples` is what keeps the read head behind the
   * frontier that actually exists.
   */
  private appliedMicAdvanceForRequestedMs(
    requestedMicAdvanceMs: number,
    frontierCorrectionSamples = this.micFrontierCorrectionSamples,
  ) {
    const corrected = this.budgetedMicAdvanceMs(requestedMicAdvanceMs)
      - (frontierCorrectionSamples / this.sampleRate) * 1000;
    return Math.max(-this.maximumMicReadBehindMs(), corrected);
  }

  get appliedMicAdvanceMs() {
    return this.appliedMicAdvanceForRequestedMs(this.requestedMicAdvanceMs);
  }

  /**
   * Runtime hold-back needed only because the live Mic frontier is behind the
   * mix clock. This is separate from a requested alignment exceeding the
   * configured prebuffer/retention budget.
   */
  get micFrontierCorrectionMs() {
    return (this.micFrontierCorrectionSamples / this.sampleRate) * 1000;
  }

  /**
   * Whether the microphone frontier has stopped keeping up with the mix clock.
   *
   * This is the difference between a capture that is *behind* and one that has
   * *stopped*, and the correction must only ever answer the first. A live but
   * late stream shows a constant deficit, so one correction settles it. A
   * stopped stream shows a deficit growing at the mix rate; chasing that would
   * pin the read head to the last samples that arrived and replay them as
   * though they were live - worse than silence, because a Take would record it.
   * Letting the read head walk past a frozen frontier is what reports the
   * starvation that is genuinely happening.
   */
  private micFrontierStalled() {
    // Arrival is packet-shaped, so single frames legitimately see no progress.
    // Only a run of them says the frontier has stopped moving.
    return this.micFrontierIdleFrames > Math.ceil(ADVANCE_SAFETY_MS / this.frameMs);
  }

  private resetMicFrontierTracking() {
    this.micFrontierCorrectionSamples = 0;
    this.micFrontierAtLastFrame = 0;
    this.micFrontierIdleFrames = 0;
    this.micFrontierResumeGuardFrames = 0;
  }

  private trackMicFrontierProgress() {
    const wasStalled = this.micFrontierStalled();
    const advanced = this.mic.totalSamples - this.micFrontierAtLastFrame;
    this.micFrontierAtLastFrame = this.mic.totalSamples;

    if (advanced > 0) {
      if (wasStalled) {
        // Keep the guard one frame longer than the stall threshold. If this was
        // only one queued stale packet, the guard then expires on the same frame
        // the frontier becomes stalled again, leaving no one-frame gap in which
        // a multi-second deficit can be mistaken for stable latency.
        this.micFrontierResumeGuardFrames = Math.ceil(ADVANCE_SAFETY_MS / this.frameMs) + 1;
      } else if (
        this.micFrontierResumeGuardFrames > 0
        && advanced <= this.frameSamples
      ) {
        // A frontier advancing faster than the mix clock is catching up queued
        // history, not proving a stable late-live offset. Keep the resume guard
        // armed until that burst has either reached the live read window or
        // settled back to roughly realtime progress.
        this.micFrontierResumeGuardFrames -= 1;
      }
      this.micFrontierIdleFrames = 0;
      return;
    }

    this.micFrontierIdleFrames += 1;
    if (this.micFrontierResumeGuardFrames > 0) {
      this.micFrontierResumeGuardFrames -= 1;
    }
  }

  /**
   * Holds the microphone read head behind the samples that have actually
   * arrived.
   *
   * Deliberately a held correction rather than a per-frame `min()` against the
   * frontier. The deficit is constant once it appears, while the frontier moves
   * in packet-sized steps: re-deriving the bound every frame would pin the read
   * position to arrival and replay the same samples between packets. So it is
   * taken in one step when the read window would overrun, with a margin so
   * ordinary arrival jitter does not force a new correction every few frames,
   * and given back at the same inaudible rate the calibration slew uses once
   * there is real slack again.
   */
  private updateMicFrontierCorrection(startSample: number) {
    if (!this.micExpected) {
      this.micFrontierCorrectionSamples = 0;
      return;
    }

    this.trackMicFrontierProgress();
    const marginSamples = Math.round((ADVANCE_SAFETY_MS * this.sampleRate) / 1000);
    const span = this.frameSamples + this.limiterLookaheadSamples;
    // The largest advance whose read window still ends inside arrived audio.
    const frontierLimit = this.mic.totalSamples - span - startSample;
    const applied = Math.round((this.appliedMicAdvanceMs * this.sampleRate) / 1000);
    const overrun = applied - frontierLimit;

    // A true stall can resume by draining queued old PCM. Do not let the first
    // such packet reinterpret the whole outage as stable live latency: with the
    // default 3 s retention that can pin the read head at -2.8 s. The guard is
    // deliberately bounded, though. If the frontier keeps moving for a full
    // safety window while remaining late, that is exactly the steady-late
    // stream this correction was introduced to keep audible.
    if (this.micFrontierResumeGuardFrames > 0 && overrun > 0) return;
    if (overrun <= 0) this.micFrontierResumeGuardFrames = 0;

    // Only worth holding back when there is arrived audio to hold back *to*.
    // A microphone that has delivered nothing, or whose whole window predates
    // the retained history, is starving however the read head is placed, and
    // moving it into the void before the timeline starts would silently turn
    // that true signal into apparent healthy headroom.
    const earliestRetained = this.mic.chunks[0]?.start ?? null;
    if (earliestRetained === null || frontierLimit < earliestRetained - startSample) {
      this.micFrontierCorrectionSamples = 0;
      return;
    }

    if (overrun > 0 && !this.micFrontierStalled()) {
      // Bounded by the retained history: growing the correction past what the
      // read head can actually move would let it climb without changing
      // anything, and reading before retention is silence just the same.
      const budgeted = Math.round((this.budgetedMicAdvanceMs() * this.sampleRate) / 1000);
      const behind = Math.round((this.maximumMicReadBehindMs() * this.sampleRate) / 1000);
      this.micFrontierCorrectionSamples = Math.min(
        budgeted + behind,
        this.micFrontierCorrectionSamples + overrun + marginSamples,
      );
      return;
    }

    if (this.micFrontierCorrectionSamples > 0 && -overrun > marginSamples) {
      const step = Math.max(
        1,
        Math.round((this.frameMs * RUNTIME_CALIBRATION_SLEW_FRACTION * this.sampleRate) / 1000),
      );
      this.micFrontierCorrectionSamples = Math.max(0, this.micFrontierCorrectionSamples - step);
    }
  }

  ingestMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    const previousTotalSamples = this.mic.totalSamples;
    const previousChunk = this.mic.chunks.at(-1) ?? null;
    const result = this.ingest(this.mic, frame, sourceRate, nowMs, false, true);
    const currentChunk = this.mic.chunks.at(-1) ?? null;
    if (result.captureRestarted && this.running) {
      this.queueCaptureRestartBoundary(
        this.micCaptureRestartBoundarySamples,
        previousTotalSamples,
      );
    }

    // Meter only samples attributable to this source frame. A streaming
    // resampler may prepend one completed target sample that belongs to the
    // previous source packet; counting it again here would double-charge the
    // packet boundary in capture diagnostics.
    this.meterMic(result.samples);

    // Only same-capture positioned holes are edited in the retained timeline.
    // A capture-clock restart is an authority boundary whose raw replacement
    // samples stay exact; bind-time replacement edges are tapered at mix output.
    const startsAfterGap = Boolean(
      !result.captureRestarted
      && previousChunk
      && currentChunk
      && currentChunk !== previousChunk
      && currentChunk.samples.length > 0
      && currentChunk.start > previousTotalSamples
    );
    if (startsAfterGap && previousChunk && currentChunk) {
      this.declickSourceGap(previousChunk.samples, currentChunk.samples);
    }
    return result;
  }

  ingestBacking(
    frame: PcmFrame,
    sourceRate: number | null,
    nowMs = performance.now(),
    trackSourceClock = false,
  ) {
    const previousTotalSamples = this.backing.totalSamples;
    const previousChunk = this.backing.chunks.at(-1) ?? null;
    const result = this.ingest(
      this.backing,
      frame,
      sourceRate,
      nowMs,
      trackSourceClock,
      true,
    );
    const currentChunk = this.backing.chunks.at(-1) ?? null;
    if (result.captureRestarted && this.running) {
      this.queueCaptureRestartBoundary(
        this.backingCaptureRestartBoundarySamples,
        previousTotalSamples,
      );
    }

    // A positioned transport/backlog hole is truthful silence, but the abrupt
    // song -> zero -> song waveform splice is not. Taper only the real PCM
    // adjacent to the proven hole; keep its position and evidence unchanged.
    // Keep capture-clock restarts byte-exact in retained source history.
    // Same-capture transport holes use the in-timeline taper; bind-time
    // replacement edges are handled separately at the mix output boundary.
    const startsAfterGap = Boolean(
      !result.captureRestarted
      && previousChunk
      && currentChunk
      && currentChunk !== previousChunk
      && currentChunk.samples.length > 0
      && currentChunk.start > previousTotalSamples
    );
    if (startsAfterGap && previousChunk && currentChunk) {
      this.declickSourceGap(previousChunk.samples, currentChunk.samples);
    }
    return result;
  }

  /** Exposed for the click diagnostic, which mixes against the microphone. */
  readMic(startSample: number, count: number) {
    return this.readRange(this.mic, startSample, count);
  }

  /** Missing-source evidence for exactly the same microphone range `readMic` reads. */
  readMicEvidence(startSample: number, count: number) {
    return this.readEvidence(this.mic, startSample, count);
  }

  /** The same window into the captured song, for locating a probe in it. */
  readBacking(startSample: number, count: number) {
    return this.readRange(this.backing, startSample, count);
  }

  /** Missing-source evidence for exactly the same backing range `readBacking` reads. */
  readBackingEvidence(startSample: number, count: number) {
    return this.readEvidence(this.backing, startSample, count);
  }

  /**
   * Session-sample coordinate for a real-world instant, independent of
   * either timeline's own anchor. This intentionally preserves fractional
   * sample position: command boundaries must quantize forward only after the
   * real instant is known. Callers that need an integer sample (such as probe
   * correlation) round explicitly at that boundary.
   */
  sessionSampleAt(nowMs: number) {
    return ((nowMs - this.startedAt) * this.sampleRate) / 1000;
  }

  trimMic(beforeSample: number) {
    this.trim(this.mic, beforeSample);
  }

  /**
   * Retires the capture that publisher activation has already replaced.
   *
   * This is intentionally source-local: an active Take keeps its mix generation
   * and Backing timeline. Clearing immediately prevents buffered PCM from the
   * retired singer/capture leaking into the bind-to-first-frame gap. Publisher
   * activation owns the bind-proven restart event; PCM reports only a later
   * capture-clock change that was not already known at bind.
   */
  retireMicCapture() {
    // Bind-time retirement has no old chunk left for declickSourceGap() to edit.
    // Preserve only the last contribution that was already audible, then taper
    // that value to whatever the next frame contains. No retired PCM survives.
    if (this.running) {
      this.micRetirementFadeStart = this.lastEmittedMicContribution;
      this.micRetirementFadeRemainingSamples = this.sourceEdgeFadeSamples;
      this.micReplacementNeedsFadeIn = true;
      this.micReplacementFadeInRemainingSamples = 0;
    }
    this.clearTimeline(this.mic);
    this.resetMicFrontierTracking();
  }

  /**
   * Retires only the captured-song clock once registration metadata has proven
   * that the new Backing transport cannot be a continuation of the old capture.
   * The shared mix epoch and Mic history remain intact.
   */
  retireBackingCapture() {
    if (this.running) {
      this.backingRetirementFadeStart = this.lastEmittedBackingContribution;
      this.backingRetirementFadeRemainingSamples = this.sourceEdgeFadeSamples;
      this.backingReplacementNeedsFadeIn = true;
      this.backingReplacementFadeInRemainingSamples = 0;
    }
    this.clearTimeline(this.backing);
  }

  clearMic() {
    this.clearTimeline(this.mic);
    this.resetMicFrontierTracking();
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
      backingClockCorrectionSamples: this.backing.clockCorrectionSamples,
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
    this.micUnplayableRunFrames = 0;
    this.backingUnplayableRunFrames = 0;
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
    this.lastEmittedMicContribution = 0;
    this.lastEmittedBackingContribution = 0;
    this.micRetirementFadeStart = 0;
    this.micRetirementFadeRemainingSamples = 0;
    this.backingRetirementFadeStart = 0;
    this.backingRetirementFadeRemainingSamples = 0;
    this.micReplacementNeedsFadeIn = false;
    this.backingReplacementNeedsFadeIn = false;
    this.micReplacementFadeInRemainingSamples = 0;
    this.backingReplacementFadeInRemainingSamples = 0;
    this.micCaptureRestartBoundarySamples.length = 0;
    this.backingCaptureRestartBoundarySamples.length = 0;
    this.micFrontierOutputMissing = false;
    this.backingFrontierOutputMissing = false;
    this.micFrontierFadeStart = 0;
    this.backingFrontierFadeStart = 0;
    this.micFrontierFadeRemainingSamples = 0;
    this.backingFrontierFadeRemainingSamples = 0;
    this.micFrontierRecoveryFadeRemainingSamples = 0;
    this.backingFrontierRecoveryFadeRemainingSamples = 0;
    this.mic.gapSamples = 0;
    this.backing.gapSamples = 0;
  }

  // ---------------------------------------------------------------- internals

  private clearTimeline(timeline: PcmTimeline) {
    if (timeline === this.mic) {
      this.resetMicReadContinuity();
      this.micCaptureRestartBoundarySamples.length = 0;
    } else if (timeline === this.backing) {
      this.backingCaptureRestartBoundarySamples.length = 0;
    }
    timeline.chunks = [];
    timeline.totalSamples = 0;
    timeline.generation = null;
    timeline.sourceRate = null;
    timeline.originOffset = 0;
    timeline.gapSamples = 0;
    timeline.unheadered = false;
    timeline.clockErrorSamples = 0;
    timeline.sourceFrontier = null;
    timeline.clockCorrectionSamples = 0;
    timeline.resampleTailSample = null;
    timeline.resampleNextTargetSample = null;
  }

  /** Where the session clock is now, in session samples since the epoch. */
  private resetMicReadContinuity() {
    this.lastEmittedMicAdvanceSamples = null;
    this.lastEmittedMicFrameComplete = false;
  }

  private currentSessionSample(nowMs = performance.now()) {
    return Math.round(((nowMs - this.startedAt) * this.sampleRate) / 1000);
  }

  private ingest(
    timeline: PcmTimeline,
    frame: PcmFrame,
    sourceRate: number | null,
    nowMs: number,
    trackSourceClock = false,
    sourceRateDefinesCapture = false,
  ): IngestResult {
    if (!sourceRate) {
      return { samples: new Int16Array(0), start: timeline.totalSamples, captureRestarted: false };
    }

    const sourceSampleCount = Math.floor(frame.pcm.byteLength / 2);
    if (sourceSampleCount <= 0) {
      return {
        samples: new Int16Array(0),
        start: timeline.totalSamples,
        captureRestarted: false,
      };
    }
    // Preserve capture-clock anchoring by the source interval's nominal target
    // span, not by how many samples the streaming resampler can emit before it
    // receives the next interpolation endpoint. An upsampled packet may defer
    // one target sample without that sample ceasing to belong to this 20 ms
    // capture interval.
    const nominalResampledSampleCount = sourceRate === this.sampleRate
      ? sourceSampleCount
      : Math.max(1, Math.round((sourceSampleCount * this.sampleRate) / sourceRate));

    let captureRestarted = false;
    let start: number;
    const positioned = frame.firstSampleIndex !== null;
    const hadCaptureClock = timeline.sourceRate !== null;
    const generationChanged = positioned && timeline.generation !== frame.generation;
    const sourceRateChanged = positioned
      && sourceRateDefinesCapture
      && hadCaptureClock
      && !generationChanged
      && timeline.sourceRate !== sourceRate;
    const captureClockChanged = positioned && (generationChanged || sourceRateChanged);
    const sourceContinuous = positioned
      && !captureClockChanged
      && timeline.sourceFrontier === frame.firstSampleIndex;
    const resampled = this.resample(
      frame.pcm,
      sourceRate,
      positioned ? frame.firstSampleIndex : null,
      sourceContinuous ? timeline.resampleTailSample : null,
      sourceContinuous ? timeline.resampleNextTargetSample : null,
    );
    let samples = resampled.samples;
    let sourceAlignedSampleOffset = resampled.sourceAlignedSampleOffset;
    if (samples.length === 0 && !positioned) {
      return { samples, start: timeline.totalSamples, captureRestarted: false };
    }

    if (!positioned) {
      // No header: the only thing left to do is append at the frontier, which
      // is the old lossy behaviour. Flag it so the UI can say the client is
      // stale rather than letting it degrade invisibly. Its source position is
      // unknowable, so it also breaks positioned resampler continuity.
      timeline.unheadered = true;
      timeline.resampleTailSample = null;
      timeline.resampleNextTargetSample = null;
      start = timeline.totalSamples;
    } else {
      // Each frame states its own position, so rounding never accumulates and a
      // missing frame leaves a hole of exactly the right length instead of
      // pulling everything after it earlier.
      const streamStart = resampled.targetStart
        ?? Math.ceil((frame.firstSampleIndex! * this.sampleRate) / sourceRate);

      captureRestarted = hadCaptureClock && captureClockChanged;
      if (captureClockChanged) {
        // A fresh capture clock. Anchor it to the session clock; the previous
        // capture's samples keep their own place and simply age out. Mic source
        // rate is part of that clock identity because firstSampleIndex is
        // expressed in source-rate samples even when a client incorrectly
        // reuses its wire generation after rebuilding the capture graph.
        timeline.generation = frame.generation;
        timeline.sourceRate = sourceRate;
        timeline.originOffset = Math.max(
          0,
          this.currentSessionSample(nowMs) - nominalResampledSampleCount,
        ) - streamStart;
        timeline.clockErrorSamples = 0;
        timeline.sourceFrontier = null;
        // The new capture is anchored to the current mix clock, so it starts
        // with healthy headroom and owes nothing to the deficit the correction
        // was covering. Carrying that forward would hold the read head a second
        // behind fresh audio and unwind only at the slew rate - most of a song.
        if (timeline === this.mic) {
          this.resetMicFrontierTracking();
          this.resetMicReadContinuity();
        }
      } else if (timeline.sourceRate === null) {
        timeline.sourceRate = sourceRate;
      }

      start = streamStart + timeline.originOffset;

      if (trackSourceClock && sourceContinuous && start === timeline.totalSamples) {
        const predictedEnd = start + samples.length;
        const rawError = Math.max(0, this.currentSessionSample(nowMs) - predictedEnd);
        timeline.clockErrorSamples += BACKING_CLOCK_ERROR_ALPHA
          * (rawError - timeline.clockErrorSamples);

        const deadbandSamples = Math.max(
          1,
          Math.round((BACKING_CLOCK_DEADBAND_MS * this.sampleRate) / 1000),
        );
        const correction = timeline.clockErrorSamples > deadbandSamples ? 1 : 0;

        if (correction > 0 && samples.length > sourceAlignedSampleOffset) {
          // Keep any deferred previous-frame interpolation prefix byte-for-byte
          // intact. Only the portion attributable to this source frame is the
          // clock-trim authority for this correction.
          const prefix = samples.subarray(0, sourceAlignedSampleOffset);
          const currentFrame = samples.subarray(sourceAlignedSampleOffset);
          const stretchedCurrentFrame = stretchPcmSpanByOne(currentFrame);
          const stretched = new Int16Array(samples.length + 1);
          stretched.set(prefix, 0);
          stretched.set(stretchedCurrentFrame, sourceAlignedSampleOffset);
          samples = stretched;

          timeline.originOffset += 1;
          timeline.clockErrorSamples -= 1;
          timeline.clockCorrectionSamples += 1;
          start = timeline.totalSamples;
        }
      }
      const sourceEnd = frame.firstSampleIndex! + sourceSampleCount;
      const previousSourceFrontier = timeline.sourceFrontier;
      const advancesSourceFrontier = captureClockChanged
        || previousSourceFrontier === null
        || sourceEnd > previousSourceFrontier;
      timeline.sourceFrontier = captureClockChanged || previousSourceFrontier === null
        ? sourceEnd
        : Math.max(previousSourceFrontier, sourceEnd);
      if (advancesSourceFrontier) {
        timeline.resampleTailSample = frame.pcm.readInt16LE((sourceSampleCount - 1) * 2);
        timeline.resampleNextTargetSample = resampled.nextTargetSample;
      }
    }

    if (start < timeline.totalSamples) {
      // Transport ordering is no longer an AudioSession contract. The packet
      // receiver normally prevents late overlap, but this boundary still must
      // not relocate old audio to "now" if a caller violates it. Keep only a
      // genuinely new tail; a fully late packet contributes nothing.
      const overlap = timeline.totalSamples - start;
      if (overlap >= samples.length) {
        return {
          samples: new Int16Array(0),
          start: timeline.totalSamples,
          captureRestarted,
        };
      }
      samples = samples.slice(overlap);
      sourceAlignedSampleOffset = Math.max(0, sourceAlignedSampleOffset - overlap);
      start = timeline.totalSamples;
    } else if (start > timeline.totalSamples && timeline.chunks.length > 0) {
      timeline.gapSamples += start - timeline.totalSamples;
    }

    if (samples.length === 0) return { samples, start, captureRestarted };
    timeline.chunks.push({ start, samples, positioned });
    timeline.totalSamples = start + samples.length;

    // Frame-scoped consumers combine this return value with the current wire
    // frame metadata. Keep a completed deferred prefix on the timeline, but do
    // not attribute that prefix to the new frame whose source clock starts later.
    const consumerOffset = Math.min(samples.length, sourceAlignedSampleOffset);
    return {
      samples: samples.subarray(consumerOffset),
      start: start + consumerOffset,
      captureRestarted,
    };
  }

  private resample(
    buffer: Buffer,
    sourceRate: number,
    sourceFirstSampleIndex: number | null = null,
    previousSourceSample: number | null = null,
    nextTargetSample: number | null = null,
  ): {
    samples: Int16Array;
    targetStart: number | null;
    nextTargetSample: number | null;
    sourceAlignedSampleOffset: number;
  } {
    const inputLength = Math.floor(buffer.byteLength / 2);
    if (inputLength <= 0) {
      return {
        samples: new Int16Array(0),
        targetStart: sourceFirstSampleIndex,
        nextTargetSample,
        sourceAlignedSampleOffset: 0,
      };
    }

    const positioned = sourceFirstSampleIndex !== null;
    if (sourceRate === this.sampleRate) {
      const output = new Int16Array(inputLength);
      for (let i = 0; i < inputLength; i += 1) output[i] = buffer.readInt16LE(i * 2);
      return {
        samples: output,
        targetStart: positioned ? sourceFirstSampleIndex : null,
        nextTargetSample: positioned ? sourceFirstSampleIndex + inputLength : null,
        sourceAlignedSampleOffset: 0,
      };
    }

    if (!positioned) {
      // Legacy headerless PCM has no source-clock position, so there is no
      // cross-packet interpolation authority. Preserve its old packet-local
      // best effort rather than pretending continuity we cannot prove.
      const outputLength = Math.max(1, Math.round((inputLength * this.sampleRate) / sourceRate));
      const output = new Int16Array(outputLength);
      const sourcePerTargetSample = sourceRate / this.sampleRate;
      for (let i = 0; i < outputLength; i += 1) {
        const position = i * sourcePerTargetSample;
        const index = Math.floor(position);
        const fraction = position - index;
        const a = buffer.readInt16LE(Math.min(index, inputLength - 1) * 2);
        const b = buffer.readInt16LE(Math.min(index + 1, inputLength - 1) * 2);
        output[i] = Math.round(a + (b - a) * fraction);
      }
      return {
        samples: output,
        targetStart: null,
        nextTargetSample: null,
        sourceAlignedSampleOffset: 0,
      };
    }

    const sourceStart = sourceFirstSampleIndex;
    const sourceEnd = sourceStart + inputLength;
    let targetIndex = nextTargetSample
      ?? Math.ceil((sourceStart * this.sampleRate) / sourceRate);
    let firstEmittedTarget: number | null = null;
    const firstCurrentFrameTarget = Math.ceil((sourceStart * this.sampleRate) / sourceRate);
    let sourceAlignedSampleOffset = 0;
    const emitted: number[] = [];

    const readAbsoluteSourceSample = (index: number) => {
      if (index === sourceStart - 1 && previousSourceSample !== null) {
        return previousSourceSample;
      }
      if (index < sourceStart || index >= sourceEnd) return null;
      return buffer.readInt16LE((index - sourceStart) * 2);
    };

    // A target sample t represents source position t * sourceRate / mixRate.
    // Emit it only when both interpolation endpoints are actually available.
    // If the second endpoint is the next packet's first source sample, leave t
    // pending; the contiguous next packet will emit it using resampleTailSample
    // plus its own first sample. This removes the 20 ms sample-hold seam without
    // inventing audio across a real source gap.
    const safetyEnd = Math.ceil((sourceEnd * this.sampleRate) / sourceRate) + 2;
    while (targetIndex <= safetyEnd) {
      const numerator = targetIndex * sourceRate;
      const sourceIndex = Math.floor(numerator / this.sampleRate);
      const remainder = numerator - sourceIndex * this.sampleRate;
      const a = readAbsoluteSourceSample(sourceIndex);

      if (a === null) {
        if (sourceIndex >= sourceEnd) break;
        targetIndex += 1;
        continue;
      }

      let value = a;
      if (remainder !== 0) {
        const b = readAbsoluteSourceSample(sourceIndex + 1);
        if (b === null) break;
        value = a + (b - a) * (remainder / this.sampleRate);
      }

      if (firstEmittedTarget === null) firstEmittedTarget = targetIndex;
      if (targetIndex < firstCurrentFrameTarget) sourceAlignedSampleOffset += 1;
      emitted.push(Math.round(value));
      targetIndex += 1;
    }

    return {
      samples: Int16Array.from(emitted),
      targetStart: firstEmittedTarget ?? targetIndex,
      nextTargetSample: targetIndex,
      sourceAlignedSampleOffset,
    };
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
   * Reads one microphone frame while a bounded runtime timing correction moves
   * the live read head.
   *
   * Both content-validation slew and frontier-correction release are explicitly
   * limited to about one percent per 20 ms frame. That is a read-rate policy:
   * the frame should consume about 19.8-20.2 ms of microphone audio. Changing
   * only the integer frame start instead skips/repeats about ten samples every
   * 20 ms at 48 kHz, a 50 Hz train of waveform discontinuities that voiced
   * harmonics expose as zipper/buzz.
   *
   * Interpolate a continuous source position across the emitted frame, landing
   * exactly on the new advance at the next frame boundary. Limiter look-ahead
   * then continues at unity rate from that landing point, so it observes the
   * same future waveform the emitted frame is moving toward. Large authority or
   * frontier-acquisition jumps remain deliberate discontinuities and do not use
   * this bounded-rate path.
   */
  private readMicSlewedRange(
    startSample: number,
    fromAdvanceSamples: number,
    toAdvanceSamples: number,
    lookaheadSamples: number,
  ) {
    const total = this.frameSamples + lookaheadSamples;
    const output = new Int16Array(total);
    const rate = 1 + ((toAdvanceSamples - fromAdvanceSamples) / this.frameSamples);

    const firstPosition = startSample + fromAdvanceSamples;
    const frameEndPosition = startSample + this.frameSamples + toAdvanceSamples;
    const lastPosition = frameEndPosition + Math.max(0, lookaheadSamples - 1);
    const sourceStart = Math.floor(Math.min(firstPosition, frameEndPosition, lastPosition));
    const sourceEnd = Math.ceil(Math.max(firstPosition, frameEndPosition, lastPosition)) + 2;
    const source = this.readRange(this.mic, sourceStart, Math.max(0, sourceEnd - sourceStart));

    const interpolate = (position: number) => {
      const index = Math.floor(position);
      const fraction = position - index;
      const offset = index - sourceStart;
      const a = source[offset] ?? 0;
      const b = source[offset + 1] ?? a;
      return Math.round(a + (b - a) * fraction);
    };

    for (let i = 0; i < this.frameSamples; i += 1) {
      output[i] = interpolate(firstPosition + i * rate);
    }
    for (let i = 0; i < lookaheadSamples; i += 1) {
      output[this.frameSamples + i] = interpolate(frameEndPosition + i);
    }
    return output;
  }

  /**
   * Crossfades an immediate Mic read-head jump without delaying its authority.
   *
   * The first sample continues the previously-emitted trajectory; by the end of
   * this short window the output is entirely the newly-authoritative trajectory.
   * Callers must prove both source windows contain real PCM before using this:
   * a crossfade must never disguise a gap or frontier miss by replaying history.
   */
  private crossfadeMicReadHeadJump(
    startSample: number,
    fromAdvanceSamples: number,
    current: Int16Array<ArrayBuffer>,
  ): Int16Array<ArrayBuffer> {
    const crossfadeSamples = Math.min(
      this.frameSamples,
      Math.max(2, Math.round((MIC_READ_HEAD_CROSSFADE_MS * this.sampleRate) / 1000)),
    );
    const firstPosition = startSample + fromAdvanceSamples;
    const sourceStart = Math.floor(firstPosition);
    const source = this.readRange(this.mic, sourceStart, crossfadeSamples + 2);

    const interpolate = (position: number) => {
      const index = Math.floor(position);
      const fraction = position - index;
      const offset = index - sourceStart;
      const a = source[offset] ?? 0;
      const b = source[offset + 1] ?? a;
      return a + (b - a) * fraction;
    };

    for (let i = 0; i < crossfadeSamples; i += 1) {
      const newWeight = crossfadeSamples === 1 ? 1 : i / (crossfadeSamples - 1);
      const oldWeight = 1 - newWeight;
      const oldSample = interpolate(firstPosition + i);
      current[i] = Math.round(oldSample * oldWeight + current[i] * newWeight);
    }
    return current;
  }

  /**
   * Describes missing/legacy source samples for exactly the requested output
   * range. Silence before session sample zero is structural pre-roll and is not
   * counted as a source failure. Missing samples inside an established frontier
   * are gaps; samples beyond the frontier are starvation/unavailability.
   */
  /**
   * Marks only proven internal positioned holes for the requested source range.
   * Frontier starvation is intentionally left unmarked: mixFrame already knows
   * that trailing boundary from readEvidence(). Structural pre-roll is neither.
   *
   * This is allocated only for frames whose aggregate evidence contains a gap,
   * keeping the ordinary hot path allocation-free.
   */
  private readGapMask(timeline: PcmTimeline, startSample: number, count: number) {
    const mask = new Uint8Array(Math.max(0, count));
    let cursor = startSample;
    let remaining = count;
    let outputOffset = 0;

    if (remaining <= 0) return mask;
    if (cursor < 0) {
      const preRoll = Math.min(remaining, -cursor);
      cursor += preRoll;
      remaining -= preRoll;
      outputOffset += preRoll;
    }
    if (
      remaining <= 0
      || timeline.chunks.length === 0
      || cursor >= timeline.totalSamples
    ) return mask;

    let chunkIndex = this.firstChunkAtOrBefore(timeline, cursor);
    while (remaining > 0 && cursor < timeline.totalSamples) {
      if (chunkIndex >= timeline.chunks.length) break;

      const chunk = timeline.chunks[chunkIndex];
      const chunkEnd = chunk.start + chunk.samples.length;
      if (cursor >= chunkEnd) {
        chunkIndex += 1;
        continue;
      }

      if (cursor < chunk.start) {
        const missing = Math.min(
          remaining,
          chunk.start - cursor,
          timeline.totalSamples - cursor,
        );
        mask.fill(1, outputOffset, outputOffset + missing);
        cursor += missing;
        remaining -= missing;
        outputOffset += missing;
        continue;
      }

      const available = Math.min(remaining, chunkEnd - cursor);
      cursor += available;
      remaining -= available;
      outputOffset += available;
      chunkIndex += 1;
    }

    return mask;
  }

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
   * Removes only the artificial edge click around a proven positioned hole.
   *
   * The missing interval stays untouched silence on the timeline, and
   * `gapSamples` / per-frame evidence still report its full duration. This is
   * deliberately not packet-loss concealment: no old sample is stretched or
   * copied across the missing capture.
   */
  private fadeOutSourceEdge(previous: Int16Array) {
    const fadeOutSamples = Math.min(this.sourceEdgeFadeSamples, previous.length);
    for (let offset = 0; offset < fadeOutSamples; offset += 1) {
      const index = previous.length - fadeOutSamples + offset;
      const weight = fadeOutSamples <= 1
        ? 0
        : (fadeOutSamples - 1 - offset) / (fadeOutSamples - 1);
      previous[index] = Math.round(previous[index] * weight);
    }
  }

  private fadeInSourceEdge(next: Int16Array) {
    const fadeInSamples = Math.min(this.sourceEdgeFadeSamples, next.length);
    for (let index = 0; index < fadeInSamples; index += 1) {
      const weight = fadeInSamples <= 1 ? 0 : index / (fadeInSamples - 1);
      next[index] = Math.round(next[index] * weight);
    }
  }

  private declickSourceGap(previous: Int16Array, next: Int16Array) {
    this.fadeOutSourceEdge(previous);
    this.fadeInSourceEdge(next);
  }

  private applyMicRetirementFade(current: number) {
    if (this.micRetirementFadeRemainingSamples <= 0) return current;
    const progress = this.sourceEdgeFadeSamples - this.micRetirementFadeRemainingSamples;
    const weight = this.sourceEdgeFadeSamples <= 1
      ? 1
      : progress / (this.sourceEdgeFadeSamples - 1);
    const value = this.micRetirementFadeStart * (1 - weight) + current * weight;
    this.micRetirementFadeRemainingSamples -= 1;
    return value;
  }

  private applyBackingRetirementFade(current: number) {
    if (this.backingRetirementFadeRemainingSamples <= 0) return current;
    const progress = this.sourceEdgeFadeSamples - this.backingRetirementFadeRemainingSamples;
    const weight = this.sourceEdgeFadeSamples <= 1
      ? 1
      : progress / (this.sourceEdgeFadeSamples - 1);
    const value = this.backingRetirementFadeStart * (1 - weight) + current * weight;
    this.backingRetirementFadeRemainingSamples -= 1;
    return value;
  }


  private applyMicReplacementFadeIn(current: number) {
    if (this.micReplacementFadeInRemainingSamples <= 0) {
      if (!this.micReplacementNeedsFadeIn || current === 0) return current;
      this.micReplacementNeedsFadeIn = false;
      this.micReplacementFadeInRemainingSamples = this.sourceEdgeFadeSamples;
    }
    const progress = this.sourceEdgeFadeSamples - this.micReplacementFadeInRemainingSamples;
    const weight = this.sourceEdgeFadeSamples <= 1
      ? 0
      : progress / (this.sourceEdgeFadeSamples - 1);
    this.micReplacementFadeInRemainingSamples -= 1;
    return current * weight;
  }

  private applyBackingReplacementFadeIn(current: number) {
    if (this.backingReplacementFadeInRemainingSamples <= 0) {
      if (!this.backingReplacementNeedsFadeIn || current === 0) return current;
      this.backingReplacementNeedsFadeIn = false;
      this.backingReplacementFadeInRemainingSamples = this.sourceEdgeFadeSamples;
    }
    const progress = this.sourceEdgeFadeSamples - this.backingReplacementFadeInRemainingSamples;
    const weight = this.sourceEdgeFadeSamples <= 1
      ? 0
      : progress / (this.sourceEdgeFadeSamples - 1);
    this.backingReplacementFadeInRemainingSamples -= 1;
    return current * weight;
  }

  private queueCaptureRestartBoundary(boundaries: number[], boundary: number) {
    const last = boundaries.at(-1);
    if (last === boundary) return;
    if (last === undefined || boundary > last) {
      boundaries.push(boundary);
      return;
    }

    // totalSamples is normally monotonic, but keep the queue ordered even if a
    // future re-anchor policy places a boundary behind a later observed one.
    const index = boundaries.findIndex((candidate) => candidate > boundary);
    if (index < 0) boundaries.push(boundary);
    else boundaries.splice(index, 0, boundary);
  }

  private consumeCaptureRestartBoundaryIfDue(boundaries: number[], sourceSample: number) {
    let due = false;
    while (boundaries.length > 0 && sourceSample >= boundaries[0]!) {
      boundaries.shift();
      due = true;
    }
    return due;
  }

  private beginMicCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.consumeCaptureRestartBoundaryIfDue(
      this.micCaptureRestartBoundarySamples,
      sourceSample,
    )) return;
    this.micRetirementFadeStart = this.lastEmittedMicContribution;
    this.micRetirementFadeRemainingSamples = this.sourceEdgeFadeSamples;
    this.micReplacementNeedsFadeIn = true;
    this.micReplacementFadeInRemainingSamples = 0;
  }

  private beginBackingCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.consumeCaptureRestartBoundaryIfDue(
      this.backingCaptureRestartBoundarySamples,
      sourceSample,
    )) return;
    this.backingRetirementFadeStart = this.lastEmittedBackingContribution;
    this.backingRetirementFadeRemainingSamples = this.sourceEdgeFadeSamples;
    this.backingReplacementNeedsFadeIn = true;
    this.backingReplacementFadeInRemainingSamples = 0;
  }

  private resetMicFrontierEdge() {
    this.micFrontierOutputMissing = false;
    this.micFrontierFadeStart = 0;
    this.micFrontierFadeRemainingSamples = 0;
    this.micFrontierRecoveryFadeRemainingSamples = 0;
  }

  private resetBackingFrontierEdge() {
    this.backingFrontierOutputMissing = false;
    this.backingFrontierFadeStart = 0;
    this.backingFrontierFadeRemainingSamples = 0;
    this.backingFrontierRecoveryFadeRemainingSamples = 0;
  }

  /**
   * De-clicks already-emitted boundaries around any proven missing source span.
   *
   * This state originally covered only live-frontier starvation. A positioned
   * packet arriving after the preceding frame was already emitted can reveal an
   * internal hole too late for declickSourceGap() to rewrite that audible edge.
   * Treat both kinds of missing sample the same at mix output while leaving raw
   * timeline positions and evidence untouched.
   */
  private applyMicFrontierEdge(current: number, sourceMissing: boolean) {
    if (sourceMissing) {
      if (!this.micFrontierOutputMissing) {
        this.micFrontierOutputMissing = true;
        this.micFrontierFadeStart = this.lastEmittedMicContribution;
        this.micFrontierFadeRemainingSamples = this.sourceEdgeFadeSamples;
        this.micFrontierRecoveryFadeRemainingSamples = 0;
      }
      if (this.micFrontierFadeRemainingSamples <= 0) return current;
      const progress = this.sourceEdgeFadeSamples - this.micFrontierFadeRemainingSamples;
      const weight = this.sourceEdgeFadeSamples <= 1
        ? 1
        : progress / (this.sourceEdgeFadeSamples - 1);
      const value = this.micFrontierFadeStart * (1 - weight) + current * weight;
      this.micFrontierFadeRemainingSamples -= 1;
      return value;
    }

    if (this.micFrontierOutputMissing) {
      // Frontier correction can temporarily read structural pre-roll after PCM
      // resumes, and a real source can legitimately resume with silence. Keep
      // the audible state at silence until there is an actual contribution to
      // fade in; otherwise the 2 ms recovery budget can be spent entirely on
      // zeros and the later first sound can still arrive as a step.
      if (current === 0) return current;
      this.micFrontierOutputMissing = false;
      this.micFrontierFadeRemainingSamples = 0;
      this.micFrontierRecoveryFadeRemainingSamples = this.sourceEdgeFadeSamples;
    }
    if (this.micFrontierRecoveryFadeRemainingSamples <= 0) return current;
    const progress = this.sourceEdgeFadeSamples - this.micFrontierRecoveryFadeRemainingSamples;
    const weight = this.sourceEdgeFadeSamples <= 1
      ? 1
      : progress / (this.sourceEdgeFadeSamples - 1);
    this.micFrontierRecoveryFadeRemainingSamples -= 1;
    return current * weight;
  }

  private applyBackingFrontierEdge(current: number, sourceMissing: boolean) {
    if (sourceMissing) {
      if (!this.backingFrontierOutputMissing) {
        this.backingFrontierOutputMissing = true;
        this.backingFrontierFadeStart = this.lastEmittedBackingContribution;
        this.backingFrontierFadeRemainingSamples = this.sourceEdgeFadeSamples;
        this.backingFrontierRecoveryFadeRemainingSamples = 0;
      }
      if (this.backingFrontierFadeRemainingSamples <= 0) return current;
      const progress = this.sourceEdgeFadeSamples - this.backingFrontierFadeRemainingSamples;
      const weight = this.sourceEdgeFadeSamples <= 1
        ? 1
        : progress / (this.sourceEdgeFadeSamples - 1);
      const value = this.backingFrontierFadeStart * (1 - weight) + current * weight;
      this.backingFrontierFadeRemainingSamples -= 1;
      return value;
    }

    if (this.backingFrontierOutputMissing) {
      // Source silence needs no transition. Preserve the pending recovery edge
      // until the first contribution that could actually create a click.
      if (current === 0) return current;
      this.backingFrontierOutputMissing = false;
      this.backingFrontierFadeRemainingSamples = 0;
      this.backingFrontierRecoveryFadeRemainingSamples = this.sourceEdgeFadeSamples;
    }
    if (this.backingFrontierRecoveryFadeRemainingSamples <= 0) return current;
    const progress = this.sourceEdgeFadeSamples - this.backingFrontierRecoveryFadeRemainingSamples;
    const weight = this.sourceEdgeFadeSamples <= 1
      ? 1
      : progress / (this.sourceEdgeFadeSamples - 1);
    this.backingFrontierRecoveryFadeRemainingSamples -= 1;
    return current * weight;
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

  private advanceMicGainDb() {
    if (this.micGainRampRemainingSamples <= 0) {
      this.micGainDbApplied = this.micGainDbValue;
      return this.micGainDbApplied;
    }

    this.micGainDbApplied += (
      this.micGainDbValue - this.micGainDbApplied
    ) / this.micGainRampRemainingSamples;
    this.micGainRampRemainingSamples -= 1;
    if (this.micGainRampRemainingSamples === 0) {
      this.micGainDbApplied = this.micGainDbValue;
    }
    return this.micGainDbApplied;
  }

  private projectedMicGainDb(samplesAhead: number) {
    if (this.micGainRampRemainingSamples <= 0) return this.micGainDbValue;
    const steps = Math.min(
      this.micGainRampRemainingSamples,
      Math.max(0, Math.round(samplesAhead)),
    );
    return this.micGainDbApplied + (
      this.micGainDbValue - this.micGainDbApplied
    ) * (steps / this.micGainRampRemainingSamples);
  }

  private advanceCalibrationSlew() {
    const target = this.calibratedMicLagTargetMs;
    const current = this.alignmentState.calibratedMicLagMs;
    if (target === null || current === null || current === target) return;

    const maximumStepMs = this.frameMs * RUNTIME_CALIBRATION_SLEW_FRACTION;
    const deltaMs = target - current;
    this.alignmentState.calibratedMicLagMs = Math.abs(deltaMs) <= maximumStepMs
      ? target
      : current + Math.sign(deltaMs) * maximumStepMs;
  }

  private mixFrame(frameIndex: number): { frame: Buffer; evidence: MixFrameEvidence } {
    const previousCalibratedMicLagMs = this.alignmentState.calibratedMicLagMs;
    const previousFrontierCorrectionSamples = this.micFrontierCorrectionSamples;
    const previousRequestedMicAdvanceMs = previousCalibratedMicLagMs === null
      ? this.alignmentState.networkCompensationMs - this.alignmentState.fineTuneMs
      : previousCalibratedMicLagMs - this.alignmentState.fineTuneMs;
    const previousAdvanceSamplesExact = (
      this.appliedMicAdvanceForRequestedMs(
        previousRequestedMicAdvanceMs,
        previousFrontierCorrectionSamples,
      ) * this.sampleRate
    ) / 1000;

    this.advanceCalibrationSlew();
    const startSample = frameIndex * this.frameSamples;
    this.updateMicFrontierCorrection(startSample);

    const appliedAdvanceMs = this.appliedMicAdvanceMs;
    const advanceSamplesExact = (appliedAdvanceMs * this.sampleRate) / 1000;
    const advanceSamples = Math.round(advanceSamplesExact);
    const micReadStart = startSample + advanceSamples;
    const previouslyEmittedAdvanceSamples = this.lastEmittedMicAdvanceSamples;

    // Calibration and frontier release can each move at the one-percent bound
    // in the same frame. Smooth that combined bounded motion, but never turn a
    // large authority/frontier acquisition jump into an accidental time-stretch.
    const maximumBoundedRuntimeDeltaSamples =
      (2 * this.frameSamples * RUNTIME_CALIBRATION_SLEW_FRACTION) + 1;
    const runtimeAdvanceDeltaSamples = advanceSamplesExact - previousAdvanceSamplesExact;
    const boundedRuntimeAdvanceMoved = Math.abs(runtimeAdvanceDeltaSamples) > 1e-9
      && Math.abs(runtimeAdvanceDeltaSamples) <= maximumBoundedRuntimeDeltaSamples;
    const immediateReadHeadJump =
      previouslyEmittedAdvanceSamples !== null
      && this.lastEmittedMicFrameComplete
      && Math.abs(advanceSamples - previouslyEmittedAdvanceSamples)
        > maximumBoundedRuntimeDeltaSamples;
    const crossfadeSamples = Math.min(
      this.frameSamples,
      Math.max(2, Math.round((MIC_READ_HEAD_CROSSFADE_MS * this.sampleRate) / 1000)),
    );
    const previousTransitionStart = previouslyEmittedAdvanceSamples === null
      ? 0
      : Math.floor(startSample + previouslyEmittedAdvanceSamples);
    const previousTransitionEvidence = immediateReadHeadJump
      ? this.readEvidence(this.mic, previousTransitionStart, crossfadeSamples + 2)
      : null;
    const nextTransitionEvidence = immediateReadHeadJump
      ? this.readEvidence(this.mic, micReadStart, crossfadeSamples)
      : null;
    const canCrossfadeReadHeadJump = Boolean(
      immediateReadHeadJump
      && previousTransitionEvidence
      && nextTransitionEvidence
      && previousTransitionEvidence.gapSamples === 0
      && previousTransitionEvidence.frontierMissingSamples === 0
      && nextTransitionEvidence.gapSamples === 0
      && nextTransitionEvidence.frontierMissingSamples === 0
    );

    // Reading ahead can outrun what has actually arrived. readRange pads with
    // zeros when that happens, so without this the vocal simply disappears in
    // chunks and nothing anywhere says why.
    // The limiter's look-ahead reads past the frame, so it is part of what has
    // to have arrived for this frame to be complete.
    const furthestAdvanceSamples = boundedRuntimeAdvanceMoved
      ? Math.max(previousAdvanceSamplesExact, advanceSamplesExact)
      : advanceSamplesExact;
    const ordinaryMicReadEnd =
      startSample + furthestAdvanceSamples + this.frameSamples + this.limiterLookaheadSamples;
    const crossfadeOldReadEnd = canCrossfadeReadHeadJump
      && previouslyEmittedAdvanceSamples !== null
      ? startSample + previouslyEmittedAdvanceSamples + crossfadeSamples + 2
      : Number.NEGATIVE_INFINITY;
    const micReadEnd = Math.ceil(Math.max(ordinaryMicReadEnd, crossfadeOldReadEnd));
    this.micHeadroomMs = ((this.mic.totalSamples - micReadEnd) / this.sampleRate) * 1000;
    this.backingHeadroomMs = ((this.backing.totalSamples - (startSample + this.frameSamples)) / this.sampleRate) * 1000;
    if (this.micHeadroomMs < 0 && this.micExpected) this.micStarvedFrames += 1;
    if (this.backingHeadroomMs < 0 && this.backingExpected) this.backingStarvedFrames += 1;

    // Take evidence is scoped only to source samples that feed this emitted
    // frame. In particular, the limiter look-ahead may be short without a single
    // emitted vocal sample being missing, so it is deliberately excluded here.
    const micReadEvidence = this.readEvidence(this.mic, micReadStart, this.frameSamples);
    const backingReadEvidence = this.readEvidence(this.backing, startSample, this.frameSamples);
    // Frontier misses are always the trailing portion of readEvidence(): unlike
    // an internal positioned gap there cannot be later retained PCM beyond the
    // known frontier. Convert the counts into output-frame boundaries once,
    // rather than re-running evidence lookup for every sample.
    const micFrontierMissingStart = this.frameSamples - micReadEvidence.frontierMissingSamples;
    const backingFrontierMissingStart =
      this.frameSamples - backingReadEvidence.frontierMissingSamples;
    const micGapMask = micReadEvidence.gapSamples > 0
      ? this.readGapMask(this.mic, micReadStart, this.frameSamples)
      : null;
    const backingGapMask = backingReadEvidence.gapSamples > 0
      ? this.readGapMask(this.backing, startSample, this.frameSamples)
      : null;

    this.micUnplayableRunFrames = this.micExpected
      && micReadEvidence.gapSamples + micReadEvidence.frontierMissingSamples > 0
      ? this.micUnplayableRunFrames + 1
      : 0;
    this.backingUnplayableRunFrames = this.backingExpected
      && backingReadEvidence.gapSamples + backingReadEvidence.frontierMissingSamples > 0
      ? this.backingUnplayableRunFrames + 1
      : 0;

    const clippedBefore = this.clippedSamples;
    const limitedBefore = this.limitedSamples;

    // The extra tail is the limiter's look-ahead, not audio to be emitted.
    const lookahead = this.limiterLookaheadSamples;
    let mic = boundedRuntimeAdvanceMoved
      ? this.readMicSlewedRange(
          startSample,
          previousAdvanceSamplesExact,
          advanceSamplesExact,
          lookahead,
        )
      : this.readRange(this.mic, micReadStart, this.frameSamples + lookahead);
    if (
      canCrossfadeReadHeadJump
      && previouslyEmittedAdvanceSamples !== null
      && !boundedRuntimeAdvanceMoved
    ) {
      mic = this.crossfadeMicReadHeadJump(
        startSample,
        previouslyEmittedAdvanceSamples,
        mic,
      );
    }
    const song = this.readRange(this.backing, startSample, this.frameSamples);
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

      const micGainDb = this.advanceMicGainDb();
      const micGain = 10 ** (micGainDb / 20);
      // The limiter detector looks ahead in source samples, so it must also see
      // the gain that will apply when that future sample reaches the output.
      const detectMicGain = 10 ** (this.projectedMicGainDb(lookahead) / 20);
      let voice = this.limit(
        (mic[i] / 32768) * micGain,
        (mic[i + lookahead] / 32768) * detectMicGain,
      );
      const micSourceSample = micReadStart + i;
      this.beginMicCaptureRestartEdgeIfDue(micSourceSample);
      if (this.micRetirementFadeRemainingSamples > 0) {
        const replacementAudible = voice !== 0;
        voice = this.applyMicRetirementFade(voice);
        if (replacementAudible) {
          this.micReplacementNeedsFadeIn = false;
          this.micReplacementFadeInRemainingSamples = 0;
        }
      } else {
        voice = this.applyMicReplacementFadeIn(voice);
      }
      const micReplacementEdgeActive =
        this.micRetirementFadeRemainingSamples > 0
        || this.micReplacementNeedsFadeIn
        || this.micReplacementFadeInRemainingSamples > 0;
      if (micReplacementEdgeActive) {
        // Explicit capture replacement/restart owns this semantic boundary. Do
        // not stack a starvation taper on top of the source transition simply
        // because the same output sample also reads as frontier-missing.
        this.resetMicFrontierEdge();
      } else {
        voice = this.applyMicFrontierEdge(
          voice,
          micGapMask?.[i] === 1 || i >= micFrontierMissingStart,
        );
      }

      let songContribution = (song[i] / 32768) * songGain;
      const backingSourceSample = startSample + i;
      this.beginBackingCaptureRestartEdgeIfDue(backingSourceSample);
      if (this.backingRetirementFadeRemainingSamples > 0) {
        const replacementAudible = songContribution !== 0;
        songContribution = this.applyBackingRetirementFade(songContribution);
        if (replacementAudible) {
          this.backingReplacementNeedsFadeIn = false;
          this.backingReplacementFadeInRemainingSamples = 0;
        }
      } else {
        songContribution = this.applyBackingReplacementFadeIn(songContribution);
      }
      const backingReplacementEdgeActive =
        this.backingRetirementFadeRemainingSamples > 0
        || this.backingReplacementNeedsFadeIn
        || this.backingReplacementFadeInRemainingSamples > 0;
      if (backingReplacementEdgeActive) {
        this.resetBackingFrontierEdge();
      } else {
        songContribution = this.applyBackingFrontierEdge(
          songContribution,
          backingGapMask?.[i] === 1 || i >= backingFrontierMissingStart,
        );
      }
      this.lastEmittedMicContribution = voice;
      this.lastEmittedBackingContribution = songContribution;
      const summed = voice + songContribution;
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
      unheaderedSamples:
        micReadEvidence.unheaderedSamples
        + backingReadEvidence.unheaderedSamples
        + (
          canCrossfadeReadHeadJump
          && previousTransitionEvidence
          && nextTransitionEvidence
            ? Math.max(
                0,
                previousTransitionEvidence.unheaderedSamples
                  - nextTransitionEvidence.unheaderedSamples,
              )
            : 0
        ),
    };

    this.lastEmittedMicAdvanceSamples = boundedRuntimeAdvanceMoved
      ? advanceSamplesExact
      : advanceSamples;
    this.lastEmittedMicFrameComplete =
      micReadEvidence.gapSamples === 0
      && micReadEvidence.frontierMissingSamples === 0;

    this.trim(this.mic, startSample - this.retentionSamples);
    this.trim(this.backing, startSample - this.backingRetentionSamples);
    return { frame: output, evidence };
  }
}
