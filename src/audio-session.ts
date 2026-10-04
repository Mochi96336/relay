import { performance } from 'node:perf_hooks';

import { concealGap } from './packet-loss-concealment.js';
import type { PcmFrame } from './pcm-frame.js';
import {
  compressPcmSpanByOne,
  emptyPcmTimeline,
  readPcmEvidence,
  readPcmGapMask,
  readPcmRange,
  readPcmSourceEvidence,
  resamplePcm,
  resetPcmTimeline,
  retainsPcmAfter,
  RESAMPLE_TAIL_SAMPLES,
  SOURCE_CONCEALED,
  SOURCE_GAP,
  SOURCE_PAST_FRONTIER,
  SOURCE_UNHEADERED,
  stretchPcmSpanByOne,
  trimPcmTimeline,
  type PcmChunk,
  type PcmTimeline,
} from './pcm-timeline.js';
import { MicClockTrim } from './mic-clock-trim.js';
import { MicFrontierCorrection } from './mic-frontier-correction.js';
import { MicInputClipping } from './mic-input-clipping.js';
import { SourceOutputEdge } from './source-output-edge.js';

/**
 * Owns the live mix: both PCM timelines, the session clock, the alignment the
 * mixer applies, and the health counters that say when any of it is failing.
 *
 * This state used to be a dozen module-level variables in `server.ts`, which
 * meant transport events reached in and reset the mix clock directly. The
 * session is now told what happened - a source appeared, a frame arrived, an
 * alignment was measured - and decides for itself what that does to the audio.
 */

export type { MicTimelineFold } from './mic-frontier-correction.js';

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
  /** Emitted Mic samples derived from a proven raw-input flat-top run. */
  micInputClippedSamples: number;
  limitedSamples: number;
  /** Mic samples held down by more than `HEAVY_LIMIT_DB`: audible, not just protective. */
  heavyLimitedSamples: number;
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
 * Real Mic history handed to concealment. Fifty milliseconds holds three
 * periods even at the 60 Hz lower pitch bound; a little extra room keeps the
 * pitch correlation window independent from that variation history.
 */
const MIC_CONCEALMENT_HISTORY_MS = 60;

/**
 * Unemitted real audio concealment needs in front of a hole: its 4 ms join,
 * plus the limiter's 3 ms look-ahead that may already have inspected it.
 */
const MIC_CONCEALMENT_JOIN_GUARD_MS = 8;

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
// Five attack time constants fit in the look-ahead, so the gain has reached
// within 1% of its target when the detected peak arrives. At 1.5 ms only two
// fitted: a plosive after quiet singing kept about 14% of the reduction still
// to come, which at the default gain is about a third above the threshold and past
// the clamp. Still a millisecond-scale ramp, so the reduction does not click.
const LIMITER_ATTACK_MS = 0.6;
const LIMITER_RELEASE_MS = 150;
const LIMITER_LOOKAHEAD_MS = 3;
/**
 * Gain reduction past which limiting is audible rather than protective. The
 * attack is sub-millisecond, so a dB or two on transients goes unheard; held
 * reduction past this is what makes a hot vocal sound squashed.
 */
export const HEAVY_LIMIT_DB = 3;
const HEAVY_LIMIT_GAIN = 10 ** (-HEAVY_LIMIT_DB / 20);

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
 * The song gain and its steady summing headroom both follow whether a
 * microphone is expected. Switched instantly that is a step of several dB in
 * the middle of a song - plainly audible, and a worse fault than the level it
 * corrects. Registration often leads real PCM, but correctness must not depend
 * on that race: the Mic-join safety crossfade below owns any audio that arrives
 * before this musical ramp settles.
 */
const SONG_DUCK_RAMP_MS = 150;
/**
 * A Mic can become audible before the slower musical duck has established
 * two-source headroom. Crossfade from the existing song-only bus into the
 * already-safe two-source bus instead of asking the final hard clamp to absorb
 * that semantic join.
 */
const SOURCE_JOIN_SAFETY_CROSSFADE_MS = 10;

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
  /**
   * A source joining an already-audible peer is not merely a slow gain change.
   * Until the normal 150 ms duck reaches its steady state, crossfade from the
   * previously audible single-source bus into a mathematically safe two-source
   * bus. Track which source joined so the old endpoint is unambiguous.
   */
  private sourceJoinSafetyPending: 'mic' | 'backing' | null = null;
  private sourceJoinSafetyActive: 'mic' | 'backing' | null = null;
  private sourceJoinSafetyBlend = 0;
  private readonly sourceJoinSafetyStep: number;
  /**
   * Expectation is transport/product intent, not proof that retained source PCM
   * has stopped reaching the bus. Keep two-source duck/headroom ownership until
   * the mixer itself has completed that source's audible fade to silence.
   */
  private micExpectationReleaseHold = false;
  private backingExpectationReleaseHold = false;
  private readonly retentionSamples: number;
  private readonly backingRetentionSamples: number;

  private readonly mic = emptyPcmTimeline();
  private readonly backing = emptyPcmTimeline();

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
  /**
   * Mic frontier safety can deliberately move the read head backwards through
   * retained history. Remember the actual source position last emitted so a
   * capture-clock seam is de-clicked every time the audible trajectory crosses
   * it, not only the first time the mixer ever encountered that position.
   */
  private lastEmittedMicSourceSample: number | null = null;
  /**
   * In-band capture-clock restarts cannot retire queued old PCM at ingest time.
   * Keep every unread old-capture frontier in order: more than one restart can
   * arrive before the mix read head reaches the first boundary.
   */
  private readonly micCaptureRestartBoundarySamples: number[] = [];
  private readonly backingCaptureRestartBoundarySamples: number[] = [];
  /** Proven raw-input flat tops of the Mic, on its retained session timeline. */
  private readonly micInputClipping = new MicInputClipping();
  /**
   * Audible edges of each source at the mix output: replacement transitions,
   * and missing-source fades that a timeline which is contiguous again (late
   * PCM filled what an earlier frame emitted as silence) cannot rewrite.
   */
  private readonly micEdge: SourceOutputEdge;
  private readonly backingEdge: SourceOutputEdge;
  private readonly sourceEdgeFadeSamples: number;

  private micStarvedFrames = 0;
  private backingStarvedFrames = 0;
  /** Consecutive emitted frames missing real source samples, whether a gap or frontier starvation. */
  private micUnplayableRunFrames = 0;
  private backingUnplayableRunFrames = 0;
  private clippedSamples = 0;
  private limitedSamples = 0;
  private heavyLimitedSamples = 0;

  // Envelope and gain reduction carry across frames; resetting them per frame
  // would put a 20 ms sawtooth on the vocal.
  private limiterEnvelope = 0;
  private limiterGain = 1;
  /**
   * A capture boundary owns fresh limiter dynamics, but a hot replacement must
   * not start blindly at unity. Seed from that capture's own look-ahead on the
   * first real audible sample instead of inheriting the retired capture.
   */
  private micLimiterResetPending = false;

  private micMeterPeak = 0;
  private micMeterPower = 0;
  private micMeterWeight = 0;
  private readonly limiterAttack: number;
  private readonly limiterRelease: number;
  private readonly limiterLookaheadSamples: number;
  private micHeadroomMs = 0;
  private micConcealedSamples = 0;
  /** Timeline position where the current Mic capture generation's audio begins. */
  private micCaptureOriginSample: number | null = null;
  /** Holds the Mic read head inside audio that has arrived. */
  private readonly micFrontier: MicFrontierCorrection;
  private readonly micClockTrim: MicClockTrim;
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
    this.sourceJoinSafetyStep = 1 / Math.max(
      1,
      Math.round((SOURCE_JOIN_SAFETY_CROSSFADE_MS / 1000) * options.sampleRate),
    );
    this.micGainRampSamples = Math.max(
      1,
      Math.round((MIC_GAIN_RAMP_MS / 1000) * options.sampleRate),
    );
    this.sourceEdgeFadeSamples = Math.max(
      1,
      Math.round((SOURCE_GAP_DECLICK_MS * options.sampleRate) / 1000),
    );
    this.micEdge = new SourceOutputEdge(this.sourceEdgeFadeSamples);
    this.backingEdge = new SourceOutputEdge(this.sourceEdgeFadeSamples);
    this.retentionMs = options.retentionMs;
    this.retentionSamples = Math.round((options.retentionMs * options.sampleRate) / 1000);
    this.backingRetentionMs = options.backingRetentionMs ?? 1_000;
    this.backingRetentionSamples = Math.round((this.backingRetentionMs * options.sampleRate) / 1000);
    this.limiterAttack = onePoleCoefficient(LIMITER_ATTACK_MS, options.sampleRate);
    this.limiterRelease = onePoleCoefficient(LIMITER_RELEASE_MS, options.sampleRate);
    this.limiterLookaheadSamples = Math.round((LIMITER_LOOKAHEAD_MS * options.sampleRate) / 1000);
    this.micFrontier = new MicFrontierCorrection({
      sampleRate: options.sampleRate,
      frameMs: options.frameMs,
      frameSamples: this.frameSamples,
      lookaheadSamples: this.limiterLookaheadSamples,
      safetyMs: ADVANCE_SAFETY_MS,
      slewFraction: RUNTIME_CALIBRATION_SLEW_FRACTION,
    });
    this.micClockTrim = new MicClockTrim(options.sampleRate);
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

  /**
   * Mic audio buffered beyond what the last mixed frame read, or null before
   * the mix is running. Unrounded, unlike health(): callers use it as a live
   * budget for how long a transport may wait before the read head needs PCM.
   */
  get liveMicHeadroomMs(): number | null {
    return this.running ? this.micHeadroomMs : null;
  }

  /** Samples of real Mic holes filled by concealment since the session began. */
  get micConcealedSampleCount() {
    return this.micConcealedSamples;
  }

  /** Capture clock error the Mic timeline is currently trimmed for, in ppm. */
  get micClockTrimPpm() {
    return this.micClockTrim.ppm;
  }

  /** Net samples inserted (positive) or removed by the trim for this capture. */
  get micClockTrimSamples() {
    return this.micClockTrim.samples;
  }

  /**
   * Trims the Mic timeline for a capture clock running `ppm` slow (positive)
   * or fast (negative) against the mix clock. Null, or an estimate inside the
   * estimator's own error, stops trimming. A capture restart clears it: the
   * next capture has its own clock and must be measured again.
   */
  setMicClockTrimPpm(ppm: number | null) {
    this.micClockTrim.setPpm(ppm);
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
    this.micFrontier.reset(this.mic.generation);
    // A pending correction belongs to the old mix epoch. Preserve the value
    // already being applied but do not continue walking an old target forward.
    this.calibratedMicLagTargetMs = this.alignmentState.calibratedMicLagMs;
    // A new session starts from what the room currently is, not from wherever
    // the previous one's ramp happened to stop.
    this.songDuck = this.backingExpected && this.micExpected ? 1 : 0;
    this.sourceJoinSafetyPending = null;
    this.sourceJoinSafetyActive = null;
    this.sourceJoinSafetyBlend = 0;
    this.micExpectationReleaseHold = false;
    this.backingExpectationReleaseHold = false;
    this.micGainDbApplied = this.micGainDbValue;
    this.micGainRampRemainingSamples = 0;
    this.resetHealth();
  }

  /**
   * Whether a source is meant to be streaming. Starvation is only meaningful
   * for a source that is supposed to be there; an absent phone is not a fault.
   */
  setMicExpected(expected: boolean) {
    const changed = expected !== this.micExpected;
    const wasReleaseHeld = this.micExpectationReleaseHold;
    const joiningExistingBacking = Boolean(
      changed
      && expected
      && this.running
      && (this.backingExpected || this.backingExpectationReleaseHold)
      && !wasReleaseHeld
    );

    this.micExpected = expected;

    if (changed && !expected && this.running) {
      // The old capture may still own retained/fading PCM. Do not release bus
      // safety until mix output proves that source has actually reached silence.
      this.micExpectationReleaseHold = true;
      if (this.sourceJoinSafetyPending === 'mic') this.sourceJoinSafetyPending = null;
    } else if (changed && expected) {
      // If false -> true happened while the release was still held, listeners
      // never heard a source disappearance. Continuing the existing bus is the
      // seamless path; starting a new source join would itself create a seam.
      this.micExpectationReleaseHold = false;
      if (joiningExistingBacking && this.sourceJoinSafetyActive === null) {
        // Registration can precede first real PCM by an arbitrary amount. Arm
        // now, but do not move the audible bus until both sources are real.
        this.sourceJoinSafetyPending = 'mic';
        this.sourceJoinSafetyBlend = 0;
      }
    }
  }

  setBackingExpected(expected: boolean) {
    const changed = expected !== this.backingExpected;
    const wasReleaseHeld = this.backingExpectationReleaseHold;
    const joiningExistingMic = Boolean(
      changed
      && expected
      && this.running
      && (this.micExpected || this.micExpectationReleaseHold)
      && !wasReleaseHeld
    );

    this.backingExpected = expected;

    if (changed && !expected && this.running) {
      this.backingExpectationReleaseHold = true;
      if (this.sourceJoinSafetyPending === 'backing') this.sourceJoinSafetyPending = null;
    } else if (changed && expected) {
      this.backingExpectationReleaseHold = false;
      if (joiningExistingMic && this.sourceJoinSafetyActive === null) {
        this.sourceJoinSafetyPending = 'backing';
        this.sourceJoinSafetyBlend = 0;
      }
    }
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
   * The frontier correction (MicFrontierCorrection) keeps the read head behind the
   * frontier that actually exists.
   */
  private appliedMicAdvanceForRequestedMs(
    requestedMicAdvanceMs: number,
    frontierCorrectionSamples = this.micFrontier.correctionSamples,
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
    return (this.micFrontier.correctionSamples / this.sampleRate) * 1000;
  }

  /**
   * Real time Mic capture `generation` is known to have lost, measured outside
   * the mixer (MicCaptureDeliveryMonitor). Only a matching capture uses it.
   */
  noteMicCaptureLoss(generation: number, lossMs: number) {
    this.micFrontier.noteCaptureLoss(generation, lossMs);
  }

  /** Folds of confirmed capture loss into the Mic timeline since this mixer was created. */
  get micTimelineFoldCount() {
    return this.micFrontier.foldCount;
  }

  get lastMicTimelineFold() {
    return this.micFrontier.lastFold;
  }

  /** The most frontier correction the retained history lets the read head use. */
  private micFrontierCorrectionCapSamples() {
    const budgeted = Math.round((this.budgetedMicAdvanceMs() * this.sampleRate) / 1000);
    const behind = Math.round((this.maximumMicReadBehindMs() * this.sampleRate) / 1000);
    return budgeted + behind;
  }

  /**
   * Folds Mic capture loss the phone has confirmed into the timeline before the
   * frontier correction covering it runs out of room (see
   * MicFrontierCorrection.foldDue for why).
   *
   * Runs before a frame reads any of the previous frame's read state, so that
   * state moves with the timeline.
   */
  private foldConfirmedMicCaptureLoss() {
    const correctionBefore = this.micFrontier.correctionSamples;
    const shift = this.micFrontier.foldDue(
      this.micExpected,
      this.mic.generation,
      this.micFrontierCorrectionCapSamples(),
    );
    if (shift === 0) return;
    this.rebaseMicTimeline(shift);
    this.micFrontier.folded(shift, correctionBefore);
  }

  /**
   * Moves the whole Mic timeline `shift` samples later and takes the same
   * amount off the frontier correction, so every frame reads exactly the audio
   * it would have read anyway. Only bookkeeping moves: the retained history,
   * the capture anchor and every position kept relative to them shift together.
   */
  private rebaseMicTimeline(shift: number) {
    for (const chunk of this.mic.chunks) chunk.start += shift;
    this.mic.totalSamples += shift;
    this.mic.originOffset += shift;
    for (let index = 0; index < this.micCaptureRestartBoundarySamples.length; index += 1) {
      this.micCaptureRestartBoundarySamples[index]! += shift;
    }
    this.micInputClipping.shift(shift);
    if (this.micCaptureOriginSample !== null) this.micCaptureOriginSample += shift;
    if (this.lastEmittedMicSourceSample !== null) this.lastEmittedMicSourceSample += shift;
    // The read position is the frame start plus the advance, so the advance
    // moves with the audio it was reading.
    if (this.lastEmittedMicAdvanceSamples !== null) this.lastEmittedMicAdvanceSamples += shift;
    this.micFrontier.rebase(shift);
  }

  /** Holds the microphone read head behind the samples that have actually arrived. */
  private updateMicFrontierCorrection(startSample: number) {
    this.micFrontier.update({
      expected: this.micExpected,
      frontier: this.mic.totalSamples,
      earliestRetained: this.mic.chunks[0]?.start ?? null,
      startSample,
      appliedAdvanceSamples: Math.round((this.appliedMicAdvanceMs * this.sampleRate) / 1000),
      capSamples: this.micFrontierCorrectionCapSamples(),
    });
  }

  ingestMic(frame: PcmFrame, sourceRate: number | null, nowMs = performance.now()) {
    const previousTotalSamples = this.mic.totalSamples;
    const previousChunk = this.mic.chunks.at(-1) ?? null;
    const previousGeneration = this.mic.generation;
    const previousSourceRate = this.mic.sourceRate;
    const previousSourceFrontier = this.mic.sourceFrontier;
    const result = this.ingest(this.mic, frame, sourceRate, nowMs, false, true);
    const currentChunk = this.mic.chunks.at(-1) ?? null;
    const addedChunk = currentChunk !== null && currentChunk !== previousChunk;
    const captureClockChanged = result.captureRestarted
      || previousGeneration !== this.mic.generation
      || previousSourceRate !== this.mic.sourceRate;
    if (captureClockChanged || (addedChunk && !previousChunk)) {
      // Where this capture's own audio begins: its first chunk, or, when the
      // whole first packet lay behind audio already retained and was trimmed
      // away, the frontier its audio has to follow. Recorded only from the
      // later chunk, the origin stayed with the retiring capture, and
      // concealment learned a pitch period across the seam between them.
      this.micCaptureOriginSample = addedChunk ? currentChunk.start : this.mic.totalSamples;
    }

    const positioned = frame.firstSampleIndex !== null;
    const sourceContinuous = Boolean(
      positioned
      && sourceRate
      && !result.captureRestarted
      && previousGeneration === frame.generation
      && previousSourceRate === sourceRate
      && previousSourceFrontier === frame.firstSampleIndex
    );
    if (!sourceContinuous) this.micInputClipping.resetRun();
    if (
      positioned
      && sourceRate
      && result.samples.length > 0
    ) {
      this.micInputClipping.observe(
        frame,
        (sourceSample) => this.micSourceSampleToSessionSample(sourceSample, sourceRate),
        sourceContinuous ? null : result.start,
      );
    }
    if (result.captureRestarted && this.running) {
      this.queueCaptureRestartBoundary(
        this.micCaptureRestartBoundarySamples,
        previousTotalSamples,
      );
    }

    // Raw level belongs to the acoustic capture. A generation/source-clock
    // replacement must not inherit the previous device or singer's meter decay.
    // Limiter state is different: old capture PCM may still be queued, so that
    // resets only when the audible read head reaches the retained boundary.
    if (result.captureRestarted) this.resetMicMeterState();

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
      if (!this.concealMicGap(previousChunk, currentChunk, previousTotalSamples)) {
        this.declickSourceGap(previousChunk, currentChunk.samples, this.firstUnheardMicSample());
      }
    }
    return result;
  }

  /**
   * Fills a proven same-capture hole with pitch-synchronous repetition instead
   * of silence. The hole's evidence is unchanged: `gapSamples` still counts it
   * and every evidence reader treats the concealed chunk as missing, so Take
   * quality, playability and calibration see exactly the loss that happened.
   * Only the audible output differs.
   */
  private concealMicGap(previousChunk: PcmChunk, currentChunk: PcmChunk, gapStart: number) {
    if (!previousChunk.positioned || !currentChunk.positioned) return false;
    // Concealment rewrites the last few milliseconds before the hole so the
    // repetition joins without a step. Once the read head has emitted those
    // samples the join cannot happen, and the output-side frontier edge already
    // owns continuity from what was actually heard - keep that path.
    const emitted = this.lastEmittedMicSourceSample;
    const guardSamples = Math.round((MIC_CONCEALMENT_JOIN_GUARD_MS * this.sampleRate) / 1000);
    if (emitted !== null && emitted >= gapStart - guardSamples) return false;
    const gapSamples = currentChunk.start - gapStart;
    const historyLength = gapStart - this.micConcealmentHistoryStart(gapStart);
    if (gapSamples <= 0 || historyLength <= 0) return false;
    const history = readPcmRange(this.mic, gapStart - historyLength, historyLength);
    // Copy on write. The joins only change what the mix will read: the PCM the
    // ingest result already handed to calibration, validation and meters stays
    // exactly what arrived.
    const previous = previousChunk.samples.slice();
    const next = currentChunk.samples.slice();
    const concealment = concealGap(
      history,
      previous,
      next,
      gapSamples,
      { sampleRate: this.sampleRate },
    );
    if (!concealment) return false;
    previousChunk.samples = previous;
    currentChunk.samples = next;

    const chunks = this.mic.chunks;
    chunks.splice(chunks.length - 1, 0, {
      start: gapStart,
      samples: concealment.fill,
      positioned: true,
      concealed: true,
    });
    this.micConcealedSamples += concealment.fill.length;
    // Without a blend the repetition has faded to silence by the end of the
    // hole (a long hole, or one exactly as long as the fade). Returning from
    // that silence is an ordinary source edge.
    if (concealment.blendedNextSamples === 0) this.fadeInSourceEdge(currentChunk.samples);
    return true;
  }

  /**
   * Oldest sample concealment may learn a period from: contiguous audio of the
   * current acoustic capture only. A pitch cycle spliced across a capture
   * restart or an earlier hole is not a period of anything the singer sang.
   */
  private micConcealmentHistoryStart(gapStart: number) {
    const floor = Math.max(
      0,
      gapStart - Math.round((MIC_CONCEALMENT_HISTORY_MS * this.sampleRate) / 1000),
      this.micCaptureOriginSample ?? 0,
    );
    const chunks = this.mic.chunks;
    let start = gapStart;
    // The last chunk is the one that just proved the hole.
    for (let index = chunks.length - 2; index >= 0 && start > floor; index -= 1) {
      const chunk = chunks[index];
      if (
        !chunk.positioned
        || chunk.concealed
        || chunk.start + chunk.samples.length !== start
      ) break;
      start = chunk.start;
    }
    return Math.max(start, floor);
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
      // The Backing is read at the mix position itself.
      this.declickSourceGap(previousChunk, currentChunk.samples, this.frameIndex * this.frameSamples);
    }
    return result;
  }

  /** Exposed for the click diagnostic, which mixes against the microphone. */
  readMic(startSample: number, count: number) {
    return readPcmRange(this.mic, startSample, count);
  }

  /** Missing-source evidence for exactly the same microphone range `readMic` reads. */
  readMicEvidence(startSample: number, count: number) {
    return readPcmEvidence(this.mic, startSample, count);
  }

  /** The same window into the captured song, for locating a probe in it. */
  readBacking(startSample: number, count: number) {
    return readPcmRange(this.backing, startSample, count);
  }

  /** Missing-source evidence for exactly the same backing range `readBacking` reads. */
  readBackingEvidence(startSample: number, count: number) {
    return readPcmEvidence(this.backing, startSample, count);
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
    if (this.running) this.micEdge.beginReplacement();
    // Limiter and raw-level history describe the retired acoustic capture.
    // Keep cumulative Take evidence. Raw level can reset immediately; limiter
    // reset is deferred until replacement PCM is actually audible so a hot new
    // capture can seed a safe gain from its own look-ahead rather than jumping
    // blindly to unity.
    this.micLimiterResetPending = true;
    this.resetMicMeterState();
    this.clearTimeline(this.mic);
    this.micFrontier.reset(this.mic.generation);
  }

  /**
   * Retires only the captured-song clock once registration metadata has proven
   * that the new Backing transport cannot be a continuation of the old capture.
   * The shared mix epoch and Mic history remain intact.
   */
  retireBackingCapture() {
    if (this.running) this.backingEdge.beginReplacement();
    this.clearTimeline(this.backing);
  }

  clearMic() {
    this.clearTimeline(this.mic);
    this.micFrontier.reset(this.mic.generation);
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
    this.resetMicMeterState();
    this.micHeadroomMs = 0;
    this.backingHeadroomMs = 0;
    // These are audio state, not just diagnostics. Carrying gain reduction into
    // a new epoch makes the beginning of the next take inherit the previous
    // singer's last transient and can attenuate it for hundreds of milliseconds.
    this.resetMicLimiterState();
    this.micEdge.reset();
    this.backingEdge.reset();
    this.lastEmittedMicSourceSample = null;
    this.micCaptureRestartBoundarySamples.length = 0;
    this.backingCaptureRestartBoundarySamples.length = 0;
    this.mic.gapSamples = 0;
    this.backing.gapSamples = 0;
  }

  // ---------------------------------------------------------------- internals

  private clearTimeline(timeline: PcmTimeline) {
    if (timeline === this.mic) {
      this.micClockTrim.reset();
      this.resetMicReadContinuity();
      this.lastEmittedMicSourceSample = null;
      this.micCaptureRestartBoundarySamples.length = 0;
      this.micInputClipping.clear();
    } else if (timeline === this.backing) {
      this.backingCaptureRestartBoundarySamples.length = 0;
    }
    resetPcmTimeline(timeline);
  }

  private micSourceSampleToSessionSample(sourceSample: number, sourceRate: number) {
    return Math.ceil((sourceSample * this.sampleRate) / sourceRate) + this.mic.originOffset;
  }

  /** Capture-scoped detector state; cumulative limiter evidence stays intact. */
  private resetMicLimiterState() {
    this.limiterEnvelope = 0;
    this.limiterGain = 1;
    this.micLimiterResetPending = false;
  }

  /**
   * Seeds limiter detector/gain from one already-buffered future window.
   *
   * This is used only at semantic edges where the previous detector state no
   * longer describes the next audible signal. It does not charge cumulative
   * limited-sample evidence; only emitted samples do.
   */
  private seedMicLimiterFromWindow(
    samples: Int16Array,
    fromOffset: number,
    toOffset: number,
    currentMicGainDb: number,
  ) {
    const end = Math.min(samples.length - 1, Math.max(fromOffset, toOffset));
    let peak = 0;
    for (let offset = fromOffset; offset <= end; offset += 1) {
      const gainDb = offset === fromOffset
        ? currentMicGainDb
        : this.projectedMicGainDb(offset - fromOffset);
      const magnitude = Math.abs(samples[offset]! / 32768) * (10 ** (gainDb / 20));
      if (magnitude > peak) peak = magnitude;
    }

    this.limiterEnvelope = peak;
    this.limiterGain = peak > LIMITER_THRESHOLD
      ? LIMITER_THRESHOLD / peak
      : 1;
  }

  /**
   * Starts a new capture's limiter from that capture's own first look-ahead.
   *
   * A fresh unity gain is unsafe when the replacement itself is already hot:
   * the ordinary attack needs time to converge, while replacement audio starts
   * immediately. Seed directly to the safe target implied by the first detector
   * window.
   */
  private seedMicLimiterForCapture(
    samples: Int16Array,
    fromOffset: number,
    toOffset: number,
    currentMicGainDb: number,
  ) {
    this.seedMicLimiterFromWindow(samples, fromOffset, toOffset, currentMicGainDb);
    this.micLimiterResetPending = false;
  }

  /** Raw Mic level belongs to the active acoustic capture, not the room. */
  private resetMicMeterState() {
    this.micMeterPeak = 0;
    this.micMeterPower = 0;
    this.micMeterWeight = 0;
  }

  /** Forgets the trajectory the last emitted Mic frame was read along. */
  private resetMicReadContinuity() {
    this.lastEmittedMicAdvanceSamples = null;
    this.lastEmittedMicFrameComplete = false;
  }

  /** Where the session clock is now, in session samples since the epoch. */
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
    const resampled = resamplePcm(
      frame.pcm,
      sourceRate,
      this.sampleRate,
      positioned ? frame.firstSampleIndex : null,
      sourceContinuous ? timeline.resampleTail : [],
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
      timeline.resampleTail = [];
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
          // The read head does not move with the capture: it is still reading
          // the retiring capture's retained audio. Whatever moves it next -
          // dropping a held correction here, or the timing a new capture
          // invalidates, applied before the next frame - must crossfade like
          // any other jump, so read continuity is kept.
          this.micFrontier.reset(this.mic.generation);
          this.micClockTrim.reset();
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

      if (
        timeline === this.mic
        && this.micClockTrim.ppm !== 0
        && timeline.sourceFrontier !== null
      ) {
        const trim = this.micClockTrim.next(
          frame.firstSampleIndex! + sourceSampleCount - timeline.sourceFrontier,
          sourceRate,
          sourceContinuous && start === timeline.totalSamples,
          samples.length - sourceAlignedSampleOffset,
        );
        if (trim !== 0) {
          // As for the Backing correction, a deferred previous-frame
          // interpolation prefix stays byte-for-byte intact.
          const prefix = samples.subarray(0, sourceAlignedSampleOffset);
          const currentFrame = samples.subarray(sourceAlignedSampleOffset);
          const trimmedCurrentFrame = trim > 0
            ? stretchPcmSpanByOne(currentFrame)
            : compressPcmSpanByOne(currentFrame);
          const trimmed = new Int16Array(prefix.length + trimmedCurrentFrame.length);
          trimmed.set(prefix, 0);
          trimmed.set(trimmedCurrentFrame, prefix.length);
          samples = trimmed;
          timeline.originOffset += trim;
          this.micClockTrim.applied(trim);
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
        const carried = sourceContinuous ? timeline.resampleTail : [];
        const own: number[] = [];
        for (let index = Math.max(0, sourceSampleCount - RESAMPLE_TAIL_SAMPLES); index < sourceSampleCount; index += 1) {
          own.push(frame.pcm.readInt16LE(index * 2));
        }
        timeline.resampleTail = [...carried, ...own].slice(-RESAMPLE_TAIL_SAMPLES);
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
    const sourceCount = Math.max(0, sourceEnd - sourceStart);
    const source = readPcmRange(this.mic, sourceStart, sourceCount);
    const sourceEvidence = readPcmSourceEvidence(this.mic, sourceStart, sourceCount);
    const missingMask = new Uint8Array(this.frameSamples);
    const inputClippingMask = !this.micInputClipping.empty
      ? new Uint8Array(this.frameSamples)
      : null;
    const crossesCaptureRestartBoundary = (sourceIndex: number) => (
      this.micCaptureRestartBoundarySamples.includes(sourceIndex + 1)
    );
    let gapSamples = 0;
    let frontierMissingSamples = 0;
    let unheaderedSamples = 0;

    const interpolate = (position: number) => {
      const index = Math.floor(position);
      const fraction = position - index;
      const offset = index - sourceStart;
      const a = source[offset] ?? 0;
      // A capture restart is a semantic discontinuity, not an interpolation
      // authority. Stay on the old side until the fractional read trajectory
      // actually reaches the new capture; the existing output replacement fade
      // owns continuity across that boundary.
      const b = fraction !== 0 && crossesCaptureRestartBoundary(index)
        ? a
        : source[offset + 1] ?? a;
      return Math.round(a + (b - a) * fraction);
    };

    for (let i = 0; i < this.frameSamples; i += 1) {
      const position = firstPosition + i * rate;
      const index = Math.floor(position);
      const fraction = position - index;
      const offset = index - sourceStart;
      let evidence = sourceEvidence[offset] ?? SOURCE_PAST_FRONTIER;
      // Interpolation normally consumes both source samples. A semantic
      // capture-restart edge deliberately does not: audio stays on the old side
      // until the source trajectory crosses the boundary, so evidence must do
      // the same.
      if (fraction !== 0 && !crossesCaptureRestartBoundary(index)) {
        evidence |= sourceEvidence[offset + 1] ?? SOURCE_PAST_FRONTIER;
      }

      if ((evidence & SOURCE_PAST_FRONTIER) !== 0) frontierMissingSamples += 1;
      // Concealment counts as a gap, but it is audible, so it is not missing.
      else if ((evidence & (SOURCE_GAP | SOURCE_CONCEALED)) !== 0) gapSamples += 1;
      if ((evidence & SOURCE_UNHEADERED) !== 0) unheaderedSamples += 1;
      if ((evidence & (SOURCE_GAP | SOURCE_PAST_FRONTIER)) !== 0) missingMask[i] = 1;
      if (inputClippingMask) {
        let clipped = this.micInputClipping.at(index);
        if (fraction !== 0 && !crossesCaptureRestartBoundary(index)) {
          clipped ||= this.micInputClipping.at(index + 1);
        }
        if (clipped) inputClippingMask[i] = 1;
      }

      output[i] = interpolate(position);
    }
    for (let i = 0; i < lookaheadSamples; i += 1) {
      output[this.frameSamples + i] = interpolate(frameEndPosition + i);
    }
    return {
      samples: output,
      evidence: { gapSamples, frontierMissingSamples, unheaderedSamples },
      missingMask,
      inputClippingMask,
      firstPosition,
      rate,
    };
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
    toStartSample: number,
    current: Int16Array<ArrayBuffer>,
  ) {
    const crossfadeSamples = Math.min(
      this.frameSamples,
      Math.max(2, Math.round((MIC_READ_HEAD_CROSSFADE_MS * this.sampleRate) / 1000)),
    );
    const firstPosition = startSample + fromAdvanceSamples;
    const previousSourceSample = this.lastEmittedMicSourceSample;
    const oldLegEnd = firstPosition + crossfadeSamples + 1;
    const restartBoundary = previousSourceSample === null
      ? null
      : this.micCaptureRestartBoundarySamples.find(
          (boundary) => previousSourceSample < boundary && boundary <= oldLegEnd,
        ) ?? null;
    const holdSourceSample = restartBoundary === null ? null : restartBoundary - 1;
    const sourceStart = Math.floor(Math.min(
      firstPosition,
      holdSourceSample ?? firstPosition,
    ));
    const sourceEnd = Math.ceil(oldLegEnd) + 1;
    const sourceCount = Math.max(0, sourceEnd - sourceStart);
    const source = readPcmRange(this.mic, sourceStart, sourceCount);
    const sourceEvidence = readPcmSourceEvidence(this.mic, sourceStart, sourceCount);
    const newLegEvidence = readPcmSourceEvidence(this.mic, toStartSample, crossfadeSamples);
    const heldOldSample = holdSourceSample === null
      ? null
      : source[holdSourceSample - sourceStart] ?? 0;
    const heldOldEvidence = holdSourceSample === null
      ? 0
      : sourceEvidence[holdSourceSample - sourceStart] ?? 0;

    const evidenceAt = (position: number) => {
      if (
        restartBoundary !== null
        && position >= restartBoundary
      ) {
        return heldOldEvidence;
      }
      const index = Math.floor(position);
      const fraction = position - index;
      const offset = index - sourceStart;
      let evidence = sourceEvidence[offset] ?? 0;
      if (
        fraction !== 0
        && !(
          restartBoundary !== null
          && index < restartBoundary
          && restartBoundary <= index + 1
        )
      ) {
        evidence |= sourceEvidence[offset + 1] ?? 0;
      }
      return evidence;
    };

    const interpolate = (position: number) => {
      if (
        restartBoundary !== null
        && heldOldSample !== null
        && position >= restartBoundary
      ) {
        // The old crossfade leg has reached a semantic capture boundary. It is
        // only continuity history for fading out the previous read trajectory,
        // so never let it enter the replacement capture. Hold the last old
        // sample while its weight falls to zero; the authoritative new
        // trajectory will cross that boundary later under the normal
        // replacement-edge state machine if it actually needs to.
        return heldOldSample;
      }

      const index = Math.floor(position);
      const fraction = position - index;
      const offset = index - sourceStart;
      const a = source[offset] ?? 0;
      const b = restartBoundary !== null
        && index < restartBoundary
        && restartBoundary <= index + 1
        ? a
        : source[offset + 1] ?? a;
      return a + (b - a) * fraction;
    };

    let actualCrossfadeUnheaderedSamples = 0;
    let newLegCrossfadeUnheaderedSamples = 0;
    let actualCrossfadeInputClippedSamples = 0;
    let newLegCrossfadeInputClippedSamples = 0;
    for (let i = 0; i < crossfadeSamples; i += 1) {
      const newWeight = crossfadeSamples === 1 ? 1 : i / (crossfadeSamples - 1);
      const oldWeight = 1 - newWeight;
      const oldPosition = firstPosition + i;
      const oldSample = interpolate(oldPosition);
      const oldUnheadered = (evidenceAt(oldPosition) & SOURCE_UNHEADERED) !== 0;
      const newUnheadered = ((newLegEvidence[i] ?? 0) & SOURCE_UNHEADERED) !== 0;

      const oldClippingPosition = (
        restartBoundary !== null
        && holdSourceSample !== null
        && oldPosition >= restartBoundary
      ) ? holdSourceSample : oldPosition;
      const oldIndex = Math.floor(oldClippingPosition);
      const oldFraction = oldClippingPosition - oldIndex;
      let oldInputClipped = this.micInputClipping.at(oldIndex);
      if (
        oldFraction !== 0
        && !(
          restartBoundary !== null
          && oldIndex < restartBoundary
          && restartBoundary <= oldIndex + 1
        )
      ) {
        oldInputClipped ||= this.micInputClipping.at(oldIndex + 1);
      }
      const newInputClipped = this.micInputClipping.at(toStartSample + i);

      if (newUnheadered) newLegCrossfadeUnheaderedSamples += 1;
      if (newInputClipped) newLegCrossfadeInputClippedSamples += 1;
      if (
        (oldWeight > 0 && oldUnheadered)
        || (newWeight > 0 && newUnheadered)
      ) {
        actualCrossfadeUnheaderedSamples += 1;
      }
      if (
        (oldWeight > 0 && oldInputClipped)
        || (newWeight > 0 && newInputClipped)
      ) {
        actualCrossfadeInputClippedSamples += 1;
      }
      current[i] = Math.round(oldSample * oldWeight + current[i] * newWeight);
    }
    return {
      samples: current,
      unheaderedSamplesDelta:
        actualCrossfadeUnheaderedSamples - newLegCrossfadeUnheaderedSamples,
      inputClippedSamplesDelta:
        actualCrossfadeInputClippedSamples - newLegCrossfadeInputClippedSamples,
    };
  }

  private trim(timeline: PcmTimeline, beforeSample: number) {
    trimPcmTimeline(timeline, beforeSample);

    if (timeline === this.mic) {
      // Restart seams are output state only while either side can still be
      // revisited by the retained Mic read head.
      while (
        this.micCaptureRestartBoundarySamples.length > 0
        && this.micCaptureRestartBoundarySamples[0]! < beforeSample
      ) {
        this.micCaptureRestartBoundarySamples.shift();
      }
      this.micInputClipping.trimBefore(beforeSample);
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

  /**
   * Tapers the real PCM on both sides of a proven same-capture hole, in the
   * retained timeline. Only audio nobody has heard yet may be rewritten. When
   * part of the taper before the hole was already emitted, rewriting the rest
   * made it start part-way down the ramp - a step against what was heard - so
   * that tail is left alone and the mix output's missing-source edge fades out
   * from what was actually heard instead.
   */
  private declickSourceGap(previous: PcmChunk, next: Int16Array, firstUnheardSample: number) {
    const taper = Math.min(this.sourceEdgeFadeSamples, previous.samples.length);
    const previousEnd = previous.start + previous.samples.length;
    if (previousEnd - Math.max(previous.start, firstUnheardSample) >= taper) {
      this.fadeOutSourceEdge(previous.samples);
    }
    this.fadeInSourceEdge(next);
  }

  /**
   * The first Mic timeline sample the mix has not read. A slewed read
   * interpolates, so the sample after a fractional position was read too.
   */
  private firstUnheardMicSample() {
    return this.lastEmittedMicSourceSample === null
      ? Number.NEGATIVE_INFINITY
      : Math.ceil(this.lastEmittedMicSourceSample) + 1;
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

  private retainedMicRestartBoundaryBetween(fromSourceSample: number, toSourceSample: number) {
    if (toSourceSample > fromSourceSample) {
      return this.micCaptureRestartBoundarySamples.find(
        (boundary) => fromSourceSample < boundary && boundary <= toSourceSample,
      ) ?? null;
    }
    if (toSourceSample < fromSourceSample) {
      for (let index = this.micCaptureRestartBoundarySamples.length - 1; index >= 0; index -= 1) {
        const boundary = this.micCaptureRestartBoundarySamples[index]!;
        if (toSourceSample < boundary && boundary <= fromSourceSample) return boundary;
      }
    }
    return null;
  }

  private crossedRetainedMicRestartBoundary(sourceSample: number) {
    const previous = this.lastEmittedMicSourceSample;
    if (previous === null || previous === sourceSample) return false;
    return this.retainedMicRestartBoundaryBetween(previous, sourceSample) !== null;
  }

  private beginMicCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.crossedRetainedMicRestartBoundary(sourceSample)) return false;
    this.micEdge.beginReplacement();
    return true;
  }

  private beginBackingCaptureRestartEdgeIfDue(sourceSample: number) {
    if (!this.consumeCaptureRestartBoundaryIfDue(
      this.backingCaptureRestartBoundarySamples,
      sourceSample,
    )) return;
    this.backingEdge.beginReplacement();
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
  private limit(value: number, detect: number, countLimitedSample = true) {
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

    if (countLimitedSample && this.limiterGain < 0.99) this.limitedSamples += 1;
    if (countLimitedSample && this.limiterGain < HEAVY_LIMIT_GAIN) this.heavyLimitedSamples += 1;
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
    this.foldConfirmedMicCaptureLoss();
    const previouslyEmittedAdvanceSamples = this.lastEmittedMicAdvanceSamples;
    const previousCalibratedMicLagMs = this.alignmentState.calibratedMicLagMs;
    const previousFrontierCorrectionSamples = this.micFrontier.correctionSamples;
    const previousRequestedMicAdvanceMs = previousCalibratedMicLagMs === null
      ? this.alignmentState.networkCompensationMs - this.alignmentState.fineTuneMs
      : previousCalibratedMicLagMs - this.alignmentState.fineTuneMs;
    const modeledPreviousAdvanceSamplesExact = (
      this.appliedMicAdvanceForRequestedMs(
        previousRequestedMicAdvanceMs,
        previousFrontierCorrectionSamples,
      ) * this.sampleRate
    ) / 1000;
    // Alignment fields can be replaced between emitted frames. In particular,
    // fineTuneMs is immediate authority and therefore cannot be used to
    // reconstruct where the preceding frame was actually heard. Once audible
    // history exists, classify runtime motion from that emitted trajectory.
    const previousAdvanceSamplesExact =
      previouslyEmittedAdvanceSamples ?? modeledPreviousAdvanceSamplesExact;

    this.advanceCalibrationSlew();
    const startSample = frameIndex * this.frameSamples;
    this.updateMicFrontierCorrection(startSample);

    const appliedAdvanceMs = this.appliedMicAdvanceMs;
    const advanceSamplesExact = (appliedAdvanceMs * this.sampleRate) / 1000;
    const advanceSamples = Math.round(advanceSamplesExact);
    const micReadStart = startSample + advanceSamples;

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
      ? readPcmEvidence(this.mic, previousTransitionStart, crossfadeSamples + 2)
      : null;
    const nextTransitionEvidence = immediateReadHeadJump
      ? readPcmEvidence(this.mic, micReadStart, crossfadeSamples)
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
    const readHeadJumped = previouslyEmittedAdvanceSamples !== null
      && Math.abs(advanceSamples - previouslyEmittedAdvanceSamples)
        > maximumBoundedRuntimeDeltaSamples;
    if (readHeadJumped && !canCrossfadeReadHeadJump) {
      // A crossfade needs real PCM on both legs: the previous frame may have
      // ended in a hole or its concealment, or the old leg may run into one.
      // The jump still must not splice. Converge from what was last heard
      // over the same 2 ms edge a capture replacement uses, which replays
      // nothing.
      this.micEdge.beginConvergence();
    }

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

    // The extra tail is the limiter's look-ahead, not audio to be emitted.
    const lookahead = this.limiterLookaheadSamples;
    const micSlew = boundedRuntimeAdvanceMoved
      ? this.readMicSlewedRange(
          startSample,
          previousAdvanceSamplesExact,
          advanceSamplesExact,
          lookahead,
        )
      : null;

    // Take evidence must describe the source samples that actually feed the
    // emitted frame. During a bounded read-rate slew that trajectory is
    // fractional and begins at the previously-emitted advance, not at the new
    // rounded micReadStart. Reuse the exact trajectory evidence produced beside
    // the interpolated PCM; keep the ordinary hot path unchanged.
    const micReadEvidence = micSlew?.evidence
      ?? readPcmEvidence(this.mic, micReadStart, this.frameSamples);
    const backingReadEvidence = readPcmEvidence(this.backing, startSample, this.frameSamples);
    // Frontier misses are always the trailing portion of ordinary readEvidence().
    // Slew frames instead carry an exact per-output missing mask because a
    // changing read rate can encounter gaps/frontier at non-trailing positions.
    const micFrontierMissingStart = this.frameSamples - micReadEvidence.frontierMissingSamples;
    const backingFrontierMissingStart =
      this.frameSamples - backingReadEvidence.frontierMissingSamples;
    const micGapMask = !micSlew && micReadEvidence.gapSamples > 0
      ? readPcmGapMask(this.mic, micReadStart, this.frameSamples)
      : null;
    const backingGapMask = backingReadEvidence.gapSamples > 0
      ? readPcmGapMask(this.backing, startSample, this.frameSamples)
      : null;
    const micInputClippingMask = micSlew?.inputClippingMask
      ?? this.micInputClipping.mask(micReadStart, this.frameSamples);

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
    const heavyLimitedBefore = this.heavyLimitedSamples;

    let mic = micSlew?.samples
      ?? readPcmRange(this.mic, micReadStart, this.frameSamples + lookahead);
    let crossfadeUnheaderedSamplesDelta = 0;
    let crossfadeMicInputClippedSamplesDelta = 0;
    if (
      canCrossfadeReadHeadJump
      && previouslyEmittedAdvanceSamples !== null
      && !boundedRuntimeAdvanceMoved
    ) {
      const crossfade = this.crossfadeMicReadHeadJump(
        startSample,
        previouslyEmittedAdvanceSamples,
        micReadStart,
        mic,
      );
      mic = crossfade.samples;
      crossfadeUnheaderedSamplesDelta = crossfade.unheaderedSamplesDelta;
      crossfadeMicInputClippedSamplesDelta = crossfade.inputClippedSamplesDelta;
    }
    const song = readPcmRange(this.backing, startSample, this.frameSamples);
    // `backingExpected` and `micExpected` are the room's semantic signals for
    // which sources this mix has. The song gain and the summing headroom both
    // exist to leave space for a voice, so both are worth paying only when
    // both sources can be there: a voice-only room is not attenuated because a
    // stale backing timeline survives from an earlier route, and a song playing
    // to a room where nobody has taken the microphone is not quietened for a
    // singer who is not there.
    const duckTarget = (
      (this.backingExpected || this.backingExpectationReleaseHold)
      && (this.micExpected || this.micExpectationReleaseHold)
    ) ? 1 : 0;
    const output = Buffer.allocUnsafe(this.frameSamples * 2);
    const micSlewFrameEndPosition = micSlew
      ? micSlew.firstPosition + this.frameSamples * micSlew.rate
      : 0;

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

      const micSourceSample = micSlew
        ? micSlew.firstPosition + i * micSlew.rate
        : micReadStart + i;
      // A retained restart can be ingested well before the read head reaches
      // it. Keep old-capture limiting until the audible trajectory actually
      // crosses the semantic boundary. The first real replacement sample then
      // seeds fresh dynamics from replacement PCM itself.
      if (this.beginMicCaptureRestartEdgeIfDue(micSourceSample)) {
        this.micLimiterResetPending = true;
      }

      const micEvidenceMissing = micSlew
        ? micSlew.missingMask[i] === 1
        : micGapMask?.[i] === 1 || i >= micFrontierMissingStart;
      // Negative session positions are structural pre-roll, not source failure,
      // so they stay out of MixFrameEvidence. They are still literal silence at
      // the output, though, and crossing from that silence back into real PCM
      // must own the same bounded de-click edge as any other audible absence.
      const micAudibleMissing = micSourceSample < 0 || micEvidenceMissing;
      const backingSourceSample = startSample + i;
      const backingSourceMissing =
        backingGapMask?.[i] === 1 || i >= backingFrontierMissingStart;
      const effectiveTwoSourceOwnership = Boolean(
        (this.micExpected || this.micExpectationReleaseHold)
        && (this.backingExpected || this.backingExpectationReleaseHold)
      );

      // The joining source enters through this crossfade as soon as it is
      // real. Waiting for its peer too let it play through the ordinary sum
      // whenever the peer happened to be missing at that moment; the crossfade
      // then started from the peer alone and cut the source already heard.
      // With the peer missing, the zero-blend endpoint is silence.
      const joiningSourceReal = this.sourceJoinSafetyPending === 'mic'
        ? !micAudibleMissing
        : !backingSourceMissing;
      if (
        this.sourceJoinSafetyPending !== null
        && this.sourceJoinSafetyActive === null
        && effectiveTwoSourceOwnership
        && joiningSourceReal
      ) {
        this.sourceJoinSafetyActive = this.sourceJoinSafetyPending;
        this.sourceJoinSafetyPending = null;
        this.sourceJoinSafetyBlend = 0;
      }

      const micGainDb = this.advanceMicGainDb();
      const micGain = 10 ** (micGainDb / 20);

      // Look-ahead belongs to one acoustic capture. Only pay the extra boundary
      // lookup while retained restart state exists; the ordinary mixer path
      // keeps the same direct +3 ms detector as before.
      let detectOffset = i + lookahead;
      if (this.micCaptureRestartBoundarySamples.length > 0) {
        const requestedDetectSourceSample = micSlew
          ? detectOffset < this.frameSamples
            ? micSlew.firstPosition + detectOffset * micSlew.rate
            : micSlewFrameEndPosition + (detectOffset - this.frameSamples)
          : micReadStart + detectOffset;
        const detectorRestartBoundary = this.retainedMicRestartBoundaryBetween(
          micSourceSample,
          requestedDetectSourceSample,
        );
        if (detectorRestartBoundary !== null) {
          // Retain every old-capture look-ahead sample that still exists. This
          // is better than disabling look-ahead wholesale near the boundary:
          // transients on the old capture remain protected without letting the
          // replacement attenuate audio that precedes its semantic ownership.
          while (detectOffset > i) {
            const candidateSourceSample = micSlew
              ? detectOffset < this.frameSamples
                ? micSlew.firstPosition + detectOffset * micSlew.rate
                : micSlewFrameEndPosition + (detectOffset - this.frameSamples)
              : micReadStart + detectOffset;
            if (candidateSourceSample < detectorRestartBoundary) break;
            detectOffset -= 1;
          }
        }
      }

      const recoveringFromFullMicSilence = !micAudibleMissing && this.micEdge.silenced;

      if (this.micLimiterResetPending && !micAudibleMissing) {
        this.seedMicLimiterForCapture(
          mic,
          i,
          detectOffset,
          micGainDb,
        );
      } else if (recoveringFromFullMicSilence) {
        // Once a missing-source edge has fully reached silence, the old limiter
        // detector has had time to release and no longer protects a suddenly
        // hot recovery. Seed from the recovered PCM's own look-ahead before the
        // first real sample becomes audible. Very short gaps that never reached
        // silence deliberately keep their existing limiter continuity.
        this.seedMicLimiterFromWindow(
          mic,
          i,
          detectOffset,
          micGainDb,
        );
      }

      // The limiter detector looks ahead in source samples, so it must also see
      // the gain that will apply when that future sample reaches the output.
      const detectMicGain = 10 ** (this.projectedMicGainDb(detectOffset - i) / 20);
      let voice = this.limit(
        (mic[i] / 32768) * micGain,
        (mic[detectOffset] / 32768) * detectMicGain,
        !micAudibleMissing,
      );

      // A proven source gap or frontier miss takes over from a capture
      // replacement; structural pre-roll is silent but not source failure, so
      // an active restart transition keeps ownership through it.
      voice = this.micEdge.apply(voice, micEvidenceMissing, micAudibleMissing);
      // Release only once the departing source has run out: silent at the
      // output *and* read past everything it retained. A hole inside the tail
      // also silences it, and releasing there un-ducked the song and dropped
      // the summing headroom under the retained PCM after the hole.
      if (
        this.micExpectationReleaseHold
        && !this.micExpected
        && this.micEdge.silenced
        && !this.micEdge.replacementActive
        && !retainsPcmAfter(this.mic, micSourceSample)
      ) {
        this.micExpectationReleaseHold = false;
      }

      let songContribution = (song[i] / 32768) * songGain;
      this.beginBackingCaptureRestartEdgeIfDue(backingSourceSample);
      songContribution = this.backingEdge.apply(
        songContribution,
        backingSourceMissing,
        backingSourceMissing,
      );
      if (
        this.backingExpectationReleaseHold
        && !this.backingExpected
        && this.backingEdge.silenced
        && !this.backingEdge.replacementActive
        && !retainsPcmAfter(this.backing, backingSourceSample)
      ) {
        this.backingExpectationReleaseHold = false;
      }
      this.lastEmittedMicSourceSample = micSourceSample;
      const summed = voice + songContribution;

      let value = summed * mixHeadroomGain;
      if (this.sourceJoinSafetyActive !== null) {
        const targetBlend = effectiveTwoSourceOwnership ? 1 : 0;
        if (this.sourceJoinSafetyBlend < targetBlend) {
          this.sourceJoinSafetyBlend = Math.min(
            targetBlend,
            this.sourceJoinSafetyBlend + this.sourceJoinSafetyStep,
          );
        } else if (this.sourceJoinSafetyBlend > targetBlend) {
          this.sourceJoinSafetyBlend = Math.max(
            targetBlend,
            this.sourceJoinSafetyBlend - this.sourceJoinSafetyStep,
          );
        }

        // While entering a two-source bus, the zero-blend endpoint is the peer
        // that was already audible before the recorded joining source arrived.
        // While leaving, expectation release holds ensure targetBlend stays at 1
        // until one source is actually missing; then the zero-blend endpoint is
        // whichever real source remains. Both endpoints are bounded, so their
        // convex crossfade never needs the final hard clamp.
        let singleSourceValue: number;
        if (targetBlend === 1) {
          singleSourceValue = this.sourceJoinSafetyActive === 'mic'
            ? songContribution * mixHeadroomGain
            : voice * mixHeadroomGain;
        } else if (!micAudibleMissing && backingSourceMissing) {
          singleSourceValue = voice * mixHeadroomGain;
        } else if (micAudibleMissing && !backingSourceMissing) {
          singleSourceValue = songContribution * mixHeadroomGain;
        } else if (micAudibleMissing && backingSourceMissing) {
          singleSourceValue = 0;
        } else {
          // Defensive fallback: effective ownership should not release while
          // both sources remain real, but preserve the original pre-join peer
          // if a future policy change violates that assumption.
          singleSourceValue = this.sourceJoinSafetyActive === 'mic'
            ? songContribution * mixHeadroomGain
            : voice * mixHeadroomGain;
        }

        const safeTwoSourceGain = sumHeadroomGain(songGain);
        const safeTwoSourceValue = summed * safeTwoSourceGain;
        const blend = this.sourceJoinSafetyBlend;
        value = singleSourceValue * (1 - blend) + safeTwoSourceValue * blend;

        if (
          targetBlend === 1
          && blend === 1
          && this.songDuck === 1
        ) {
          // At steady duck the safe endpoint is byte-for-byte the ordinary
          // two-source path, so safety ownership can return without a seam.
          this.sourceJoinSafetyActive = null;
          this.sourceJoinSafetyBlend = 0;
        } else if (
          targetBlend === 0
          && blend === 0
          && (micAudibleMissing || backingSourceMissing)
        ) {
          this.sourceJoinSafetyActive = null;
          this.sourceJoinSafetyBlend = 0;
        }
      }

      // Normal two-source peaks have already had deterministic summing headroom
      // reserved. Keep this clamp as an invariant/backstop for unexpected future
      // inputs or limiter overshoot, and keep counting it as audible distortion.
      if (value > 1 || value < -1) this.clippedSamples += 1;
      const clamped = Math.max(-1, Math.min(1, value));
      output.writeInt16LE(Math.round(clamped < 0 ? clamped * 32768 : clamped * 32767), i * 2);
    }

    let micInputClippedSamples = 0;
    if (micInputClippingMask) {
      for (let i = 0; i < micInputClippingMask.length; i += 1) {
        if (micInputClippingMask[i] !== 1) continue;
        const missing = micSlew
          ? micSlew.missingMask[i] === 1
          : micGapMask?.[i] === 1 || i >= micFrontierMissingStart;
        if (!missing) micInputClippedSamples += 1;
      }
    }
    micInputClippedSamples += crossfadeMicInputClippedSamplesDelta;

    const evidence: MixFrameEvidence = {
      micGapSamples: micReadEvidence.gapSamples,
      backingGapSamples: backingReadEvidence.gapSamples,
      micStarvedSamples: this.micExpected ? micReadEvidence.frontierMissingSamples : 0,
      backingStarvedSamples: this.backingExpected ? backingReadEvidence.frontierMissingSamples : 0,
      micUnavailableSamples: this.micExpected ? 0 : micReadEvidence.frontierMissingSamples,
      backingUnavailableSamples: this.backingExpected ? 0 : backingReadEvidence.frontierMissingSamples,
      clippedSamples: this.clippedSamples - clippedBefore,
      micInputClippedSamples: Math.max(0, micInputClippedSamples),
      limitedSamples: this.limitedSamples - limitedBefore,
      heavyLimitedSamples: this.heavyLimitedSamples - heavyLimitedBefore,
      unheaderedSamples:
        micReadEvidence.unheaderedSamples
        + backingReadEvidence.unheaderedSamples
        + crossfadeUnheaderedSamplesDelta,
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
