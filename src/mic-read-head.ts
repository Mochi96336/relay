import { classifyMicReadMotion, type MicReadMotionInput } from './mic-read-plan.js';

export type AlignmentState = {
  networkCompensationMs: number;
  calibratedMicLagMs: number | null;
  fineTuneMs: number;
};
export type MicCalibrationAuthority = Readonly<{ revision: number; kind: 'none' | 'content' | 'boot-probe' }>;
export type MicReadHeadEvent =
  | { kind: 'jump'; fromMs: number; toMs: number; waitedMs: number; quiet: boolean;
      moved: Partial<Record<keyof AlignmentState | 'frontierCorrectionMs', number | null>> }
  | { kind: 'walk-start' | 'walk-end' | 'walk-cancel'; what: 'calibration' | 'network'; fromMs: number; toMs: number };

type EmittedAlignment = AlignmentState & { frontierCorrectionSamples: number };
type JumpState = { kind: 'following' } | { kind: 'waiting'; frames: number; targetMs: number };
type ReadMotion = ReturnType<typeof classifyMicReadMotion>;
type ReadHeadInput = Omit<MicReadMotionInput, 'previouslyEmittedAdvanceSamples' | 'lastEmittedMicFrameComplete'>;
export type MicReadHeadFrame = ReadMotion & {
  epoch: number;
  requestId: number;
  alignment: EmittedAlignment;
  authority: MicCalibrationAuthority | null;
  waiting: boolean;
  jump: Extract<MicReadHeadEvent, { kind: 'jump' }> | null;
};

/**
 * One singer's correction lifecycle. Requests, walk targets, quiet waits and
 * emitted acknowledgements have one owner. PCM, frontier safety and rendering
 * remain MicTrack's responsibilities; measurement authority stays upstream.
 */
export class MicReadHead {
  private value: AlignmentState = { networkCompensationMs: 0, calibratedMicLagMs: null, fineTuneMs: 0 };
  private calibrationTarget: number | null = null;
  private networkTarget: number | null = null;
  private jump: JumpState = { kind: 'following' };
  private emitted: EmittedAlignment | null = null;
  private fallbackBaseline = 0;
  private advance: number | null = null;
  private complete = false;
  private requestId = 0;
  private epoch = 0;
  private acceptedAuthority: MicCalibrationAuthority | null = null;
  private renderedAuthority: MicCalibrationAuthority | null = null;
  private settlement: { requestId: number; atSample: number; advanceMs: number; authority: MicCalibrationAuthority | null } | null = null;
  private readonly events: MicReadHeadEvent[] = [];

  constructor(private readonly options: {
    sampleRate: number; frameMs: number; slewFraction: number;
    walkLimitMs: number; jumpQuietWaitMs: number;
  }) {}

  get alignment(): AlignmentState { return { ...this.value }; }
  get calibratedMicLagTargetMs() { return this.calibrationTarget; }
  get networkCompensationTargetMs() { return this.networkTarget; }
  get emittedAdvanceSamples() { return this.advance; }
  get emittedFrameComplete() { return this.complete; }
  get heardMicAdvanceMs() { return this.advance === null ? null : this.ms(this.advance); }
  get renderedCalibrationKind() { return this.renderedAuthority?.kind ?? 'none'; }
  get jumpWaitMs() { return this.jump.kind === 'waiting' ? this.jump.frames * this.options.frameMs : 0; }

  /** Compare the live target with the trajectory actually rendered, not only the accepted setting. */
  divergenceFrom(desiredLagMs: number | null, appliedAdvanceMs: number) {
    if (desiredLagMs === null || this.value.calibratedMicLagMs === null) return null;
    return desiredLagMs - this.value.calibratedMicLagMs
      + appliedAdvanceMs - (this.heardMicAdvanceMs ?? appliedAdvanceMs);
  }

  get status() {
    const walking = this.hasAudibleWalk;
    return {
      epoch: this.epoch,
      requestId: this.requestId,
      phase: this.jump.kind === 'waiting' ? 'waiting-for-quiet' as const
        : walking ? 'walking' as const
        : this.settlement?.requestId === this.requestId ? 'settled' as const : 'pending' as const,
      waitMs: this.jumpWaitMs,
      acceptedCalibration: this.acceptedAuthority === null ? null : { ...this.acceptedAuthority },
      renderedCalibration: this.renderedAuthority === null ? null : { ...this.renderedAuthority },
      settled: this.settlement === null ? null : {
        ...this.settlement,
        authority: this.settlement.authority === null ? null : { ...this.settlement.authority },
      },
    };
  }

  setAlignment(patch: Partial<AlignmentState>) {
    const next = { ...this.value, ...patch };
    const calibration = Object.hasOwn(patch, 'calibratedMicLagMs');
    const network = Object.hasOwn(patch, 'networkCompensationMs');
    if (Object.keys(patch).some(key => next[key as keyof AlignmentState] !== this.value[key as keyof AlignmentState])
      || (calibration && this.calibrationTarget !== next.calibratedMicLagMs)
      || (network && this.networkTarget !== null)) {
      this.beginRequest();
    }
    if (calibration) {
      this.cancelWalk('calibration');
      this.calibrationTarget = next.calibratedMicLagMs;
    }
    if (network) {
      this.cancelWalk('network');
      this.networkTarget = null;
    }
    this.value = next;
  }

  acceptCalibration(authority: MicCalibrationAuthority | null) {
    if (this.acceptedAuthority?.revision === authority?.revision && this.acceptedAuthority?.kind === authority?.kind) return;
    this.acceptedAuthority = authority === null ? null : { ...authority };
    this.beginRequest();
  }

  walkCalibrationTo(targetMs: number, running: boolean) {
    if (!Number.isFinite(targetMs)) return false;
    const current = this.value.calibratedMicLagMs;
    if (current === null || !running || Math.abs(targetMs - current) > this.options.walkLimitMs) {
      const changed = current !== targetMs || this.calibrationTarget !== targetMs;
      this.setAlignment({ calibratedMicLagMs: targetMs });
      return changed;
    }
    if (this.calibrationTarget === targetMs) return false;
    if (this.calibrationTarget === null || this.calibrationTarget === current) {
      this.note({ kind: 'walk-start', what: 'calibration', fromMs: current, toMs: targetMs });
    }
    this.calibrationTarget = targetMs;
    this.beginRequest();
    return true;
  }

  walkFallbackTo(targetMs: number, running: boolean) {
    if (!Number.isFinite(targetMs)) return;
    if (!running) { this.setAlignment({ networkCompensationMs: targetMs }); return; }
    const current = this.value.networkCompensationMs;
    const next = targetMs === current ? null : targetMs;
    if (next === this.networkTarget) return;
    if (next === null) this.cancelWalk('network');
    else if (this.networkTarget === null) this.note({ kind: 'walk-start', what: 'network', fromMs: current, toMs: targetMs });
    this.networkTarget = next;
    this.beginRequest();
  }

  advanceWalks() {
    const step = this.options.frameMs * this.options.slewFraction;
    for (const what of ['calibration', 'network'] as const) {
      const key = what === 'calibration' ? 'calibratedMicLagMs' : 'networkCompensationMs';
      const current = this.value[key];
      const target = what === 'calibration' ? this.calibrationTarget : this.networkTarget;
      if (current === null || target === null || current === target) continue;
      const delta = target - current;
      this.value[key] = Math.abs(delta) <= step ? target : current + Math.sign(delta) * step;
      if (this.value[key] === target) {
        if (what === 'network') this.networkTarget = null;
        this.note({ kind: 'walk-end', what, fromMs: current, toMs: target });
      }
    }
  }

  /** Withdraw an unrendered fallback request; no effect on acoustic authority. */
  freezeFallbackAtHeard() {
    this.setAlignment({ networkCompensationMs: this.fallbackBaseline });
  }

  resetFallbackForOwner() {
    this.setAlignment({ networkCompensationMs: 0 });
    this.fallbackBaseline = 0;
  }

  /** New PCM epoch: retire motion and audible receipts, retaining current alignment. */
  resetContinuity() {
    this.epoch++;
    this.cancelWalk('calibration');
    this.cancelWalk('network');
    this.calibrationTarget = this.value.calibratedMicLagMs;
    this.networkTarget = null;
    this.jump = { kind: 'following' };
    this.advance = null;
    this.complete = false;
    this.emitted = null;
    this.fallbackBaseline = this.value.networkCompensationMs;
    this.acceptedAuthority = null;
    this.renderedAuthority = null;
    this.settlement = null;
    this.beginRequest();
  }

  clear() {
    this.setAlignment({ calibratedMicLagMs: null, networkCompensationMs: 0, fineTuneMs: 0 });
    this.resetContinuity();
  }

  plan(input: ReadHeadInput, frontierCorrectionSamples: number, safety: {
    mayWait: boolean;
    canKeepReading(): boolean;
    quiet(from: number, to: number, samples: number): boolean;
  }): MicReadHeadFrame {
    const motionInput = { ...input,
      previouslyEmittedAdvanceSamples: this.advance,
      previousAdvanceSamplesExact: this.advance ?? input.previousAdvanceSamplesExact,
      lastEmittedMicFrameComplete: this.complete,
    };
    let motion = classifyMicReadMotion(motionInput);
    // Nearby target noise is still the same correction. It must not postpone
    // a held note forever by restarting the quiet-wait budget on every report.
    const continuing = this.jump.kind === 'waiting'
      && Math.abs(input.appliedAdvanceMs - this.jump.targetMs) <= this.options.walkLimitMs;
    const waitedFrames = continuing && this.jump.kind === 'waiting' ? this.jump.frames : 0;
    const waitedMs = waitedFrames * this.options.frameMs;
    const quiet = () => safety.quiet(Math.floor(input.startSample + (this.advance ?? 0)), motion.micReadStart, motion.crossfadeSamples);
    let jump: MicReadHeadFrame['jump'] = null;
    let waiting = false;
    if (motion.readHeadJumped && this.advance !== null) {
      const isQuiet = quiet();
      if (safety.mayWait && waitedMs < this.options.jumpQuietWaitMs && safety.canKeepReading() && !isQuiet) {
        this.jump = { kind: 'waiting', frames: waitedFrames + 1,
          targetMs: continuing && this.jump.kind === 'waiting' ? this.jump.targetMs : input.appliedAdvanceMs };
        waiting = true;
        motion = classifyMicReadMotion({ ...motionInput, appliedAdvanceMs: this.ms(this.advance) });
      } else {
        jump = { kind: 'jump', fromMs: this.ms(this.advance), toMs: this.ms(motion.advanceSamples),
          waitedMs, quiet: isQuiet, moved: this.moved(frontierCorrectionSamples) };
        this.jump = { kind: 'following' };
      }
    } else this.jump = { kind: 'following' };
    return { ...motion, epoch: this.epoch, requestId: this.requestId, alignment: { ...this.value, frontierCorrectionSamples },
      authority: this.acceptedAuthority === null ? null : { ...this.acceptedAuthority }, waiting, jump };
  }

  /** Called beside the actual mixed PCM, never by a status query or admission command. */
  emittedFrame(frame: MicReadHeadFrame, startSample: number, complete: boolean) {
    if (frame.epoch !== this.epoch) return;
    this.advance = frame.boundedRuntimeAdvanceMoved ? frame.advanceSamplesExact : frame.advanceSamples;
    this.complete = complete;
    if (frame.waiting) return;
    this.emitted = { ...frame.alignment };
    this.renderedAuthority = frame.alignment.calibratedMicLagMs === null || frame.authority === null
      ? null : { ...frame.authority };
    this.fallbackBaseline = frame.alignment.networkCompensationMs;
    if (frame.jump) this.note(frame.jump);
    const walking = this.hasAudibleWalk;
    if (complete && !walking && frame.requestId === this.requestId) {
      // A receipt names the first frame, not the most recent periodic observation.
      if (this.settlement?.requestId !== frame.requestId) {
        this.settlement = { requestId: frame.requestId, atSample: startSample,
          advanceMs: this.ms(this.advance), authority: this.renderedAuthority === null ? null : { ...this.renderedAuthority } };
      }
    }
  }

  /** A coordinate rebase moves history, not a correction or its authority. */
  rebase(shift: number) {
    if (this.advance !== null) this.advance += shift;
    if (this.emitted !== null) this.emitted.frontierCorrectionSamples -= shift;
    if (this.settlement !== null) this.settlement.advanceMs += this.ms(shift);
  }

  drainEvents() { return this.events.splice(0); }
  private get hasAudibleWalk() {
    return this.value.calibratedMicLagMs === null ? this.networkTarget !== null
      : this.calibrationTarget !== this.value.calibratedMicLagMs;
  }
  private beginRequest() {
    this.requestId++;
  }
  private ms(samples: number) { return samples * 1000 / this.options.sampleRate; }
  private note(event: MicReadHeadEvent) {
    if (this.events.length >= 64) this.events.shift();
    this.events.push(event);
  }
  private cancelWalk(what: 'calibration' | 'network') {
    const current = what === 'calibration' ? this.value.calibratedMicLagMs : this.value.networkCompensationMs;
    const target = what === 'calibration' ? this.calibrationTarget : this.networkTarget;
    if (current !== null && target !== null && current !== target) {
      this.note({ kind: 'walk-cancel', what, fromMs: current, toMs: target });
    }
  }
  private moved(frontier: number): Extract<MicReadHeadEvent, { kind: 'jump' }>['moved'] {
    const before = this.emitted;
    if (before === null) return {};
    const moved: Extract<MicReadHeadEvent, { kind: 'jump' }>['moved'] = {};
    for (const key of ['calibratedMicLagMs', 'networkCompensationMs', 'fineTuneMs'] as const) {
      const from = before[key], to = this.value[key];
      if (from !== to) moved[key] = from === null || to === null ? null : to - from;
    }
    if (frontier !== before.frontierCorrectionSamples) moved.frontierCorrectionMs = this.ms(frontier - before.frontierCorrectionSamples);
    return moved;
  }
}
