import {
  DEFAULT_MIC_UPLINK_BACKLOG_END_MS,
  DEFAULT_MIC_UPLINK_BACKLOG_START_MS,
} from './mic-uplink-backlog.js';

/**
 * When a Mic frontier overrun counts as gradual: the frontier has stayed
 * within this much of the read window for a whole window of frames. A capture
 * clock spending the headroom does that for minutes before it overruns; a
 * healthy stream that stalls or arrives in bursts overruns from ~200 ms of
 * slack and still needs the whole safety margin at once.
 */
const MIC_FRONTIER_GRADUAL_WINDOW_MS = 1_000;
const MIC_FRONTIER_GRADUAL_SLACK_MS = 60;

/**
 * A correction that slack past the safety margin could give back by at least
 * this much is given back in one step rather than at the slew rate: delayed
 * audio has caught up, and holding the read head back keeps the voice that far
 * behind the song. Less than this is given back at the slew rate as before.
 * The step is a read-head jump, which the mixer crossfades.
 */
const MIC_FRONTIER_PROMPT_RELEASE_MS = 100;

/**
 * Confirmed Mic capture loss is folded into the timeline only once the frontier
 * correction is within this much of its bound. The fold is inaudible, but it
 * restarts any timing measurement in flight, so it should be rare; one burst
 * of loss plus the safety margin must still fit after the decision.
 */
const MIC_TIMELINE_FOLD_ROOM_MS = 1_000;
/**
 * Confirmed loss below this is measurement noise, not capture loss: the
 * phone's health reports arrive with jitter that the lower envelope only
 * mostly removes. Folding noise would turn real network lateness, which can
 * still catch up, into permanent lateness.
 */
const MIC_TIMELINE_FOLD_MIN_MS = 250;

/** One fold of confirmed Mic capture loss into the timeline, or the undoing of one. */
export type MicTimelineFold = {
  shiftMs: number;
  correctionBeforeMs: number;
  captureLossMs: number;
};

export type MicTimelineUnfold = MicTimelineFold & {
  /** The part of the unfold the calibration in force was measured across, and gave up. */
  calibrationMs: number;
};

export type MicFrontierCorrectionOptions = {
  sampleRate: number;
  frameMs: number;
  frameSamples: number;
  /** Samples the limiter reads past the frame: part of what has to have arrived. */
  lookaheadSamples: number;
  /** Jitter headroom the read-ahead is never allowed to eat. */
  safetyMs: number;
  /** Largest change of the read rate a runtime correction may make, as a fraction. */
  slewFraction: number;
};

/** The Mic as one frame sees it, sampled by the mixer just before it reads. */
export type MicFrontierFrame = {
  /** Whether the Mic is meant to be streaming at all. */
  expected: boolean;
  /** Write frontier of the Mic timeline. */
  frontier: number;
  /** Start of the oldest retained Mic audio, or null when none is retained. */
  earliestRetained: number | null;
  /** Session sample this frame begins at. */
  startSample: number;
  /** The advance the mixer would read with, under the current correction. */
  appliedAdvanceSamples: number;
  /** The most correction the retained history lets the read head use. */
  capSamples: number;
};

/**
 * Holds the microphone read head behind the samples that have actually
 * arrived, and decides when confirmed capture loss can stop being held.
 *
 * Deliberately a held correction rather than a per-frame `min()` against the
 * frontier. The deficit is constant once it appears, while the frontier moves
 * in packet-sized steps: re-deriving the bound every frame would pin the read
 * position to arrival and replay the same samples between packets. So it is
 * taken in one step when the read window would overrun, with a margin so
 * ordinary arrival jitter does not force a new correction every few frames,
 * and given back at the same inaudible rate the calibration slew uses once
 * there is real slack again.
 *
 * A frontier that runs out gradually is different: a phone capture clock a
 * little slower than the mix clock spends the headroom over tens of minutes
 * and overruns by a fraction of a frame. Stepping the whole margin then
 * replayed about 200 ms of voice in one go. Such an overrun is stepped back
 * only to a frame inside arrived audio, and the rest of the margin is taken
 * at the bounded slew rate.
 */
export class MicFrontierCorrection {
  private readonly frameSamples: number;
  private readonly lookaheadSamples: number;
  private readonly sampleRate: number;
  private readonly stallFrames: number;
  private readonly marginSamples: number;
  private readonly gradualWindowFrames: number;
  private readonly gradualSlackSamples: number;
  private readonly slewStepSamples: number;
  private readonly foldRoomSamples: number;
  private readonly foldMinSamples: number;
  private readonly promptReleaseSamples: number;

  /** Samples the read head is held back to stay inside arrived microphone audio. */
  private correction = 0;
  private frontierAtLastFrame = 0;
  /** Consecutive mixed frames in which no new microphone audio arrived. */
  private idleFrames = 0;
  /**
   * Bounded settling window after a truly stalled frontier starts moving again.
   * A queued stale packet must not instantly redefine seconds of outage as live
   * latency, but a genuinely steady late stream must regain frontier correction.
   */
  private resumeGuardFrames = 0;
  /**
   * Correction still to be taken at the bounded slew rate, after a frontier
   * that ran out gradually was stepped back only to just inside arrived audio.
   */
  private slewTarget: number | null = null;
  /** Live frontier slack of recent frames, oldest first. */
  private readonly recentSlack: number[] = [];
  /**
   * Real time the Mic capture `captureLossGeneration` is known to have lost,
   * measured outside the mixer from the phone's own sample count.
   */
  private captureLossGeneration: number | null = null;
  private captureLossSamples = 0;
  /** The part of that loss already folded into the timeline or absorbed by its anchor. */
  private foldedSamples = 0;
  private foldCountValue = 0;
  private lastFoldValue: MicTimelineFold | null = null;
  /** How far folds have moved the current capture's timeline, net of unfolds. */
  private timelineFoldedSamples = 0;
  /** The part of it the calibration in force was measured across (see noteCalibrationMeasured). */
  private calibratedFoldedSamples = 0;
  private unfoldCountValue = 0;
  private lastUnfoldValue: MicTimelineUnfold | null = null;
  /**
   * Whether the phone has captured audio that has not reached Relay yet, by
   * more than ordinary network delay (see MicUplinkBacklog). While it has, the
   * read head is not held back for it: that audio can only be heard late.
   */
  private inTransit = false;
  /** The correction at the last uplink report that showed nothing in transit. */
  private quietCorrection = 0;

  constructor(options: MicFrontierCorrectionOptions) {
    const { sampleRate, frameMs, safetyMs } = options;
    this.sampleRate = sampleRate;
    this.frameSamples = options.frameSamples;
    this.lookaheadSamples = options.lookaheadSamples;
    this.stallFrames = Math.ceil(safetyMs / frameMs);
    this.marginSamples = Math.round((safetyMs * sampleRate) / 1000);
    this.gradualWindowFrames = Math.ceil(MIC_FRONTIER_GRADUAL_WINDOW_MS / frameMs);
    this.gradualSlackSamples = Math.round((MIC_FRONTIER_GRADUAL_SLACK_MS * sampleRate) / 1000);
    this.slewStepSamples = Math.max(
      1,
      Math.round((frameMs * options.slewFraction * sampleRate) / 1000),
    );
    this.foldRoomSamples = Math.round((MIC_TIMELINE_FOLD_ROOM_MS * sampleRate) / 1000);
    this.foldMinSamples = Math.round((MIC_TIMELINE_FOLD_MIN_MS * sampleRate) / 1000);
    this.promptReleaseSamples = Math.round((MIC_FRONTIER_PROMPT_RELEASE_MS * sampleRate) / 1000);
  }

  get correctionSamples() {
    return this.correction;
  }

  /** Whether captured audio is in transit beyond ordinary delay (see noteTransit). */
  get transitActive() {
    return this.inTransit;
  }

  /** Folds of confirmed capture loss into the Mic timeline since this mixer was created. */
  get foldCount() {
    return this.foldCountValue;
  }

  get lastFold(): MicTimelineFold | null {
    return this.lastFoldValue;
  }

  /** Folds undone because the loss they folded turned out not to be capture loss. */
  get unfoldCount() {
    return this.unfoldCountValue;
  }

  get lastUnfold(): MicTimelineUnfold | null {
    return this.lastUnfoldValue;
  }

  get timelineFoldedSamplesNow() {
    return this.timelineFoldedSamples;
  }

  /**
   * Real time Mic capture `generation` is known to have lost, measured outside
   * the mixer (MicCaptureDeliveryMonitor). Only a matching capture uses it.
   */
  noteCaptureLoss(generation: number, lossMs: number) {
    if (!Number.isFinite(lossMs) || lossMs < 0) return;
    this.captureLossGeneration = generation;
    this.captureLossSamples = Math.round((lossMs * this.sampleRate) / 1000);
  }

  /**
   * How much captured audio of the current capture had not reached Relay at
   * its latest uplink report (MicUplinkBacklog). Starting a transit episode
   * drops the correction back to what it was before the audio started queueing:
   * whatever it grew by since was holding the voice back for audio in transit.
   */
  noteTransit(backlogMs: number) {
    if (!Number.isFinite(backlogMs)) return;
    if (!this.inTransit) {
      if (backlogMs < DEFAULT_MIC_UPLINK_BACKLOG_START_MS) {
        if (backlogMs < DEFAULT_MIC_UPLINK_BACKLOG_END_MS) this.quietCorrection = this.correction;
        return;
      }
      this.inTransit = true;
      this.correction = Math.min(this.correction, this.quietCorrection);
      this.slewTarget = null;
      return;
    }
    if (backlogMs < DEFAULT_MIC_UPLINK_BACKLOG_END_MS) {
      this.inTransit = false;
      this.quietCorrection = this.correction;
    }
  }

  /**
   * Starts over for timeline positions that no longer mean what they did: a
   * new mix epoch, a retired capture, or a fresh anchor for `generation`.
   */
  reset(generation: number | null) {
    this.correction = 0;
    this.frontierAtLastFrame = 0;
    this.idleFrames = 0;
    this.resumeGuardFrames = 0;
    this.slewTarget = null;
    this.recentSlack.length = 0;
    this.inTransit = false;
    this.quietCorrection = 0;
    this.timelineFoldedSamples = 0;
    this.calibratedFoldedSamples = 0;
    // A fresh anchor already places the capture where it is now, so whatever
    // it had lost up to here is accounted for and must not be folded again.
    this.foldedSamples = this.captureLossGeneration !== null
      && this.captureLossGeneration === generation
      ? this.captureLossSamples
      : 0;
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
  private stalled() {
    // Arrival is packet-shaped, so single frames legitimately see no progress.
    // Only a run of them says the frontier has stopped moving.
    return this.idleFrames > this.stallFrames;
  }

  private trackProgress(frontier: number) {
    const wasStalled = this.stalled();
    const advanced = frontier - this.frontierAtLastFrame;
    this.frontierAtLastFrame = frontier;

    if (advanced > 0) {
      if (wasStalled) {
        // Keep the guard one frame longer than the stall threshold. If this was
        // only one queued stale packet, the guard then expires on the same frame
        // the frontier becomes stalled again, leaving no one-frame gap in which
        // a multi-second deficit can be mistaken for stable latency.
        this.resumeGuardFrames = this.stallFrames + 1;
      } else if (
        this.resumeGuardFrames > 0
        && advanced <= this.frameSamples
      ) {
        // A frontier advancing faster than the mix clock is catching up queued
        // history, not proving a stable late-live offset. Keep the resume guard
        // armed until that burst has either reached the live read window or
        // settled back to roughly realtime progress.
        this.resumeGuardFrames -= 1;
      }
      this.idleFrames = 0;
      return;
    }

    this.idleFrames += 1;
    if (this.resumeGuardFrames > 0) {
      this.resumeGuardFrames -= 1;
    }
  }

  /** Decides this frame's correction, before the frame reads. */
  update(frame: MicFrontierFrame) {
    // Whether the frontier is moving is a fact about arrival, kept even while
    // the Mic is not expected. A WebSocket phone whose socket drops is not
    // expected until it registers again, and its next packet lands a round
    // trip after that. Tracked only while expected, a frontier frozen for the
    // whole outage looked fresh in those frames and was taken for lateness:
    // the read head went back into the audio from before the drop, replayed
    // it, and the voice then ran seconds late for minutes.
    this.trackProgress(frame.frontier);
    if (!frame.expected) {
      this.correction = 0;
      this.slewTarget = null;
      this.recentSlack.length = 0;
      return;
    }

    const marginSamples = this.marginSamples;
    const span = this.frameSamples + this.lookaheadSamples;
    // The largest advance whose read window still ends inside arrived audio.
    const frontierLimit = frame.frontier - span - frame.startSample;
    const overrun = frame.appliedAdvanceSamples - frontierLimit;
    const recentSlack = this.recentSlack;
    const frontierHasBeenShort = recentSlack.length >= this.gradualWindowFrames
      && Math.max(...recentSlack) <= this.gradualSlackSamples;
    recentSlack.push(-overrun);
    if (recentSlack.length > this.gradualWindowFrames) recentSlack.shift();

    // A true stall can resume by draining queued old PCM. Do not let the first
    // such packet reinterpret the whole outage as stable live latency: with the
    // default 3 s retention that can pin the read head at -2.8 s. The guard is
    // deliberately bounded, though. If the frontier keeps moving for a full
    // safety window while remaining late, that is exactly the steady-late
    // stream this correction was introduced to keep audible.
    if (this.resumeGuardFrames > 0 && overrun > 0) return;
    if (overrun <= 0) this.resumeGuardFrames = 0;

    // Only worth holding back when there is arrived audio to hold back *to*.
    // A microphone that has delivered nothing, or whose whole window predates
    // the retained history, is starving however the read head is placed, and
    // moving it into the void before the timeline starts would silently turn
    // that true signal into apparent healthy headroom.
    const earliestRetained = frame.earliestRetained;
    if (earliestRetained === null || frontierLimit < earliestRetained - frame.startSample) {
      this.correction = 0;
      this.slewTarget = null;
      return;
    }

    if (overrun > 0 && !this.stalled() && !this.inTransit) {
      // Bounded by the retained history: growing the correction past what the
      // read head can actually move would let it climb without changing
      // anything, and reading before retention is silence just the same.
      const target = Math.min(
        frame.capSamples,
        this.correction + overrun + marginSamples,
      );
      if (overrun <= this.frameSamples && frontierHasBeenShort) {
        // One frame of cushion covers packet-sized arrival steps, so the
        // frontier is not overrun again before the slew has built slack.
        this.correction = Math.min(
          target,
          this.correction + overrun + this.frameSamples,
        );
        this.slewTarget = target > this.correction
          ? target
          : null;
      } else {
        this.correction = target;
        this.slewTarget = null;
      }
      return;
    }

    const step = this.slewStepSamples;
    const slewTarget = this.slewTarget;
    if (slewTarget !== null) {
      // A frontier that stops is starvation, not latency to hold back for; and
      // once the margin is back there is nothing left to take.
      if (this.stalled() || -overrun >= marginSamples) {
        this.slewTarget = null;
      } else {
        this.correction = Math.min(
          slewTarget,
          this.correction + step,
        );
        if (this.correction >= slewTarget) this.slewTarget = null;
        return;
      }
    }

    if (this.correction > 0 && -overrun > marginSamples) {
      const releasable = Math.min(this.correction, -overrun - marginSamples);
      this.correction -= releasable >= this.promptReleaseSamples
        ? releasable
        : Math.min(this.correction, step);
    }
  }

  /**
   * Confirmed capture loss ready to be folded into the timeline, in samples,
   * or zero when none is due.
   *
   * A phone whose audio graph loses render time sends contiguous sample numbers
   * that fall behind the wall clock. Its frontier slides behind the mix and the
   * correction grows with every burst, but the correction is bounded by the
   * retained history: once pinned, the read head runs past arrived audio for
   * good. On 2026-10-03 a Mic stayed silent for almost four minutes that way
   * while its packets kept arriving. Time the phone never captured cannot catch
   * up later, so it can move out of the correction and into the timeline's own
   * positions. Lateness the phone does not confirm stays a correction, to be
   * given back if delayed audio catches up.
   */
  foldDue(expected: boolean, generation: number | null, capSamples: number) {
    const correction = this.correction;
    if (!expected || correction <= 0) return 0;
    if (
      this.captureLossGeneration === null
      || this.captureLossGeneration !== generation
    ) return 0;
    const roomSamples = capSamples - correction;
    if (roomSamples > this.foldRoomSamples) return 0;
    const shift = Math.min(
      correction,
      Math.floor(this.captureLossSamples - this.foldedSamples),
    );
    if (shift < this.foldMinSamples) return 0;
    return shift;
  }

  /**
   * Folded loss to take back out of the timeline, in samples, or zero when none
   * is due.
   *
   * Loss the phone never captured cannot come back, so confirmed loss that
   * falls again was never capture loss. On 2026-10-09 the Mic was on the
   * WebSocket path, where uplink health queues behind the audio: a 0.8 s queue
   * delayed the reports with it, read as 767 ms of capture loss, and was
   * folded. Two seconds later the loss read 34 ms again, but the timeline kept
   * the voice 767 ms behind the song until the Mic was taken again. Undoing the
   * fold moves the timeline back and holds the same amount as correction, so
   * the read head does not move; the correction is then given back like any
   * other once there is slack.
   */
  unfoldDue(expected: boolean, generation: number | null, capSamples: number) {
    if (!expected || this.timelineFoldedSamples <= 0) return 0;
    if (
      this.captureLossGeneration === null
      || this.captureLossGeneration !== generation
    ) return 0;
    const shift = Math.min(
      this.timelineFoldedSamples,
      Math.floor(this.foldedSamples - this.captureLossSamples),
      capSamples - this.correction,
    );
    if (shift <= 0) return 0;
    // Partly fallen loss is undone past the same noise floor a fold needs. Loss
    // that has fallen back to nothing undoes what is left, however small: the
    // floor would otherwise keep up to 250 ms of the voice behind the song.
    if (shift < this.foldMinSamples && this.captureLossSamples >= this.frameSamples) return 0;
    return shift;
  }

  /**
   * A calibration measured from the current capture's timeline as it stands
   * now is in force. The server restarts Mic evidence whenever the timeline
   * moves (reportMicTimelineFolds), so the measurement saw every fold already
   * in place and none since.
   */
  noteCalibrationMeasured() {
    this.calibratedFoldedSamples = this.timelineFoldedSamples;
  }

  /**
   * How much of an unfold of `shift` samples the calibration in force was
   * measured across, and must give up with it.
   *
   * A calibration measured across a fold places the voice by the folded
   * timeline. Moving the timeline back from under it leaves the read head
   * ahead of the voice by the fold once the correction is given back, the gap
   * #534 left open. Folds made after the measurement go first, since a loss
   * that falls again within seconds is most likely the one folded last.
   */
  unfoldMeasuredAcross(shift: number) {
    const sinceMeasured = this.timelineFoldedSamples - this.calibratedFoldedSamples;
    return Math.min(this.calibratedFoldedSamples, Math.max(0, shift - sinceMeasured));
  }

  /**
   * Gives back `samples` of correction at once, for a read head moved back by
   * the advance itself, so the frame still reads the audio it would have.
   */
  release(samples: number) {
    this.correction = Math.max(0, this.correction - samples);
    if (this.slewTarget !== null && this.slewTarget <= this.correction) this.slewTarget = null;
  }

  /**
   * Moves this correction's positions `shift` samples later with the timeline,
   * taking the same amount off the correction, so the read head lands on
   * exactly the audio it would have read anyway.
   */
  rebase(shift: number) {
    this.frontierAtLastFrame += shift;
    this.correction -= shift;
    if (this.slewTarget !== null) {
      const target = this.slewTarget - shift;
      this.slewTarget = target > this.correction ? target : null;
    }
  }

  /** Records a fold of `shift` samples, taken while the correction stood at `correctionBefore`. */
  folded(shift: number, correctionBefore: number) {
    this.foldedSamples += shift;
    this.timelineFoldedSamples += shift;
    this.foldCountValue += 1;
    this.lastFoldValue = {
      shiftMs: Math.round((shift / this.sampleRate) * 1000),
      correctionBeforeMs: Math.round((correctionBefore / this.sampleRate) * 1000),
      captureLossMs: Math.round((this.captureLossSamples / this.sampleRate) * 1000),
    };
  }

  /**
   * Records an unfold of `shift` samples, taken while the correction stood at
   * `correctionBefore`, of which the calibration in force gave up
   * `measuredAcross` (see unfoldMeasuredAcross).
   */
  unfolded(shift: number, correctionBefore: number, measuredAcross = 0) {
    this.foldedSamples -= shift;
    this.timelineFoldedSamples -= shift;
    this.calibratedFoldedSamples -= measuredAcross;
    this.unfoldCountValue += 1;
    this.lastUnfoldValue = {
      shiftMs: Math.round((shift / this.sampleRate) * 1000),
      correctionBeforeMs: Math.round((correctionBefore / this.sampleRate) * 1000),
      captureLossMs: Math.round((this.captureLossSamples / this.sampleRate) * 1000),
      calibrationMs: Math.round((measuredAcross / this.sampleRate) * 1000),
    };
  }
}
