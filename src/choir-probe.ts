import { decideBootProbeAnalysisEvidence } from './boot-probe-analysis-evidence-policy.js';
import { mediaToWallMs } from './boot-calibration.js';
import { MAX_CAPTURE_GAP_MS } from './calibration-session.js';
import { locateProbe, PROBE_REFERENCE_MS } from './calibration-probe.js';
import { probeScheduleTime, sanitizeProbeTimingDiagnostics } from './probe-timing-diagnostics.js';

/**
 * The second singer's test tone: the main Mic's boot probe, for B.
 *
 * The boot probe plays the same three notes at one server-chosen moment on
 * the phone and on the Robot. The phone's notes travel speaker → Mic →
 * timeline exactly as the song does on its way to the singer and back as
 * their voice; the Robot's travel exactly as the backing does. Where each
 * lands, one minus the other, is the Mic's advance.
 *
 * The Robot's leg belongs to the Robot route, not to whoever sings, so it is
 * kept apart (the server's backing path) and reused: B plays only its own
 * notes, unless no Robot leg has been measured on this backing capture yet
 * (the main Mic sang with headphones, say), in which case the Robot plays its
 * notes first. B's advance = B's Mic path − backing path + the Robot player's
 * offset, the boot calibration's own formula.
 *
 * Automatically once per B capture, as B arrives; again whenever B asks.
 * B is silent in the room output while its own notes are out.
 */

/** Where one side's timeline is read: B's room-output timeline, or the backing. */
export type ProbeLegTimeline = {
  totalSamples: () => number;
  /** The capture the reply must belong to; null when nothing is on the timeline. */
  generation: () => number | null;
  read: (start: number, count: number) => Int16Array;
  evidence: (start: number, count: number) => { gapSamples: number; frontierMissingSamples: number } | null;
};

export type ProbeLegConfig = {
  sampleRate: number;
  leadMs: number;
  searchMarginMs: number;
  minCorrelation: number;
  replyTimeoutMs: number;
  analysisTimeoutMs: number;
  sessionSampleAt: (atMs: number) => number;
};

type LegOutcome =
  | { kind: 'pending' }
  | { kind: 'analyzing' }
  | { kind: 'measured'; latencyMs: number }
  | { kind: 'failed'; reason: string };

/** One side of a boot probe: ask for the notes, find where they landed. */
export class ProbeLeg {
  private state: 'requested' | 'analyzing' | 'done' = 'requested';
  private analysis: { targetSample: number; windowStart: number; windowSamples: number; deadlineMs: number } | null = null;
  correlation: number | null = null;

  constructor(
    private readonly config: ProbeLegConfig,
    private readonly timeline: ProbeLegTimeline,
    readonly requestId: number,
    private readonly sentAtMs: number,
    /** Null for the Robot, whose page has no capture of its own to name. */
    private readonly generation: number | null,
  ) {}

  played(reply: { generation?: unknown; timingDiagnostics?: unknown }, nowMs: number): LegOutcome {
    if (this.state !== 'requested') return { kind: 'pending' };
    if (this.generation !== null && Number(reply.generation) !== this.generation) {
      return this.fail('capture changed');
    }
    const client = sanitizeProbeTimingDiagnostics(reply.timingDiagnostics);
    const schedule = probeScheduleTime(this.sentAtMs, nowMs, this.config.leadMs, client);
    const { sampleRate, searchMarginMs } = this.config;
    const targetSample = Math.round(this.config.sessionSampleAt(schedule.targetAtMs));
    const marginSamples = Math.round((sampleRate * searchMarginMs) / 1000);
    const referenceSamples = Math.round((sampleRate * PROBE_REFERENCE_MS) / 1000);
    this.analysis = {
      targetSample,
      windowStart: targetSample - Math.round(marginSamples / 8),
      windowSamples: referenceSamples + marginSamples,
      deadlineMs: nowMs + this.config.analysisTimeoutMs,
    };
    this.state = 'analyzing';
    return { kind: 'analyzing' };
  }

  tick(nowMs: number): LegOutcome {
    if (this.state === 'done') return { kind: 'pending' };
    if (this.state === 'requested') {
      return nowMs - this.sentAtMs > this.config.replyTimeoutMs ? this.fail('page did not answer') : { kind: 'pending' };
    }
    const analysis = this.analysis!;
    if (this.generation !== null && this.timeline.generation() !== this.generation) return this.fail('capture changed');
    if (this.timeline.totalSamples() < analysis.windowStart + analysis.windowSamples) {
      return nowMs > analysis.deadlineMs ? this.fail('audio did not reach the analyzer in time') : { kind: 'pending' };
    }
    const evidence = this.timeline.evidence(analysis.windowStart, analysis.windowSamples);
    if (!evidence) return this.fail('capture went away');
    const decision = decideBootProbeAnalysisEvidence({
      gapSamples: evidence.gapSamples,
      frontierMissingSamples: evidence.frontierMissingSamples,
      sampleRate: this.config.sampleRate,
      maxGapMs: MAX_CAPTURE_GAP_MS,
    });
    if (decision.kind === 'reject') return this.fail(`audio had a ${Math.round(decision.gapMs)} ms gap`);
    const window = this.timeline.read(analysis.windowStart, analysis.windowSamples);
    const { offsetSamples, correlation } = locateProbe(window, this.config.sampleRate);
    this.correlation = correlation;
    // With headphones the notes never reach the Mic; trying again would not either.
    if (correlation < this.config.minCorrelation) return this.fail('not heard (headphones?)');
    this.state = 'done';
    const actualSample = analysis.windowStart + offsetSamples;
    return { kind: 'measured', latencyMs: ((actualSample - analysis.targetSample) / this.config.sampleRate) * 1000 };
  }

  fail(reason: string): LegOutcome {
    this.state = 'done';
    return { kind: 'failed', reason };
  }
}

export type ChoirProbeState = 'idle' | 'robot' | 'requested' | 'analyzing' | 'measured' | 'failed';

export type ChoirProbeOptions = ProbeLegConfig & {
  secondary: ProbeLegTimeline;
  backing: ProbeLegTimeline;
  /** The Robot route's own leg, kept by the server; null when none is valid. */
  backingLatencyMs: () => number | null;
  /** A Robot leg this probe measured, for the server to keep. */
  onBackingMeasured: (latencyMs: number) => void;
  /** Whether the Robot can be asked now (connected, and not mid boot probe). */
  robotAvailable: () => boolean;
  sendSecondary: (request: { requestId: number; leadMs: number }) => boolean;
  sendRobot: (request: { requestId: number; leadMs: number }) => boolean;
};

/** Ids above any the boot probe's own counter will reach, so replies cannot be confused. */
const REQUEST_ID_BASE = 1_000_000_000;

export class ChoirProbe {
  state: ChoirProbeState = 'idle';
  failureReason: string | null = null;
  /** B's Mic path: where its notes landed after the moment they were due. */
  micLatencyMs: number | null = null;
  correlation: number | null = null;
  private captureKey: string | null = null;
  private nextRequestId = REQUEST_ID_BASE;
  private leg: ProbeLeg | null = null;

  constructor(private readonly options: ChoirProbeOptions) {}

  /** B's notes are out or being looked for: keep B out of the room output. */
  get silencing() {
    return this.state === 'requested' || this.state === 'analyzing';
  }

  /** Any part of the probe is running, the Robot's leg included. */
  get running() {
    return this.state === 'robot' || this.silencing;
  }

  /**
   * The automatic probe: once per B capture. A capture already probed (or
   * failed) is not probed again; `realign` does that on request.
   */
  begin(captureKey: string, nowMs: number) {
    if (captureKey === this.captureKey) return false;
    this.captureKey = captureKey;
    this.start(nowMs);
    return true;
  }

  /** B asked: probe again, whatever this capture measured before. */
  realign(captureKey: string, nowMs: number) {
    if (this.running) return false;
    this.captureKey = captureKey;
    this.start(nowMs);
    return true;
  }

  private start(nowMs: number) {
    this.failureReason = null;
    this.micLatencyMs = null;
    this.correlation = null;
    if (this.options.backingLatencyMs() !== null) {
      this.startSecondary(nowMs);
    } else if (this.options.robotAvailable()) {
      this.state = 'robot';
      this.leg = new ProbeLeg(this.options, this.options.backing, this.nextRequestId++, nowMs, null);
      if (!this.options.sendRobot({ requestId: this.leg.requestId, leadMs: this.options.leadMs })) {
        this.finishFailed('Robot: request could not be sent');
      }
    } else {
      this.finishFailed('no Robot path to measure against');
    }
  }

  private startSecondary(nowMs: number) {
    const generation = this.options.secondary.generation();
    if (generation === null) {
      this.finishFailed('B has no audio yet');
      return;
    }
    this.state = 'requested';
    this.leg = new ProbeLeg(this.options, this.options.secondary, this.nextRequestId++, nowMs, generation);
    if (!this.options.sendSecondary({ requestId: this.leg.requestId, leadMs: this.options.leadMs })) {
      this.finishFailed('B: request could not be sent');
    }
  }

  /** Whether a Robot reply with this id answers this probe (and not the boot probe). */
  ownsRobotRequest(requestId: unknown) {
    return this.state === 'robot' && this.leg !== null && requestId === this.leg.requestId;
  }

  robotPlayed(reply: { requestId: unknown; timingDiagnostics?: unknown }, nowMs: number) {
    if (!this.ownsRobotRequest(reply.requestId)) return false;
    this.apply(this.leg!.played(reply, nowMs), nowMs);
    return true;
  }

  played(reply: { requestId: unknown; generation: unknown; timingDiagnostics?: unknown }, nowMs: number) {
    const leg = this.leg;
    if (this.state !== 'requested' || !leg || reply.requestId !== leg.requestId) return false;
    this.apply(leg.played(reply, nowMs), nowMs);
    return true;
  }

  clientFailed(reply: { requestId: unknown; reason?: unknown }, nowMs: number) {
    const leg = this.leg;
    if (!this.running || !leg || reply.requestId !== leg.requestId) return false;
    const reason = typeof reply.reason === 'string' ? reply.reason.slice(0, 200) : 'could not play the notes';
    this.apply(leg.fail(`${this.state === 'robot' ? 'Robot' : 'B'} page: ${reason}`), nowMs);
    return true;
  }

  tick(nowMs: number) {
    if (this.running && this.leg) this.apply(this.leg.tick(nowMs), nowMs);
  }

  private apply(outcome: LegOutcome, nowMs: number) {
    if (outcome.kind === 'pending') return;
    if (outcome.kind === 'analyzing') {
      // The Robot's leg reports as 'robot' throughout; B's moves on.
      if (this.state === 'requested') this.state = 'analyzing';
      return;
    }
    if (outcome.kind === 'failed') {
      this.correlation = this.leg?.correlation ?? null;
      this.finishFailed(this.state === 'robot' ? `Robot: ${outcome.reason}` : outcome.reason);
      return;
    }
    if (this.state === 'robot') {
      this.options.onBackingMeasured(outcome.latencyMs);
      this.startSecondary(nowMs);
      return;
    }
    this.correlation = this.leg?.correlation ?? null;
    this.micLatencyMs = outcome.latencyMs;
    this.leg = null;
    this.state = 'measured';
  }

  private finishFailed(reason: string) {
    this.leg = null;
    this.state = 'failed';
    this.failureReason = reason;
  }

  /** B's advance against the Robot route's backing path; null until both exist. */
  advanceMs(deltaMs: number, playbackRate: number) {
    const backingLatencyMs = this.options.backingLatencyMs();
    if (this.state !== 'measured' || this.micLatencyMs === null
      || backingLatencyMs === null || !Number.isFinite(backingLatencyMs)) return null;
    return this.micLatencyMs - backingLatencyMs + mediaToWallMs(deltaMs, playbackRate);
  }

  status() {
    return {
      state: this.state,
      micLatencyMs: this.micLatencyMs === null ? null : Math.round(this.micLatencyMs),
      correlation: this.correlation === null ? null : Number(this.correlation.toFixed(3)),
      failureReason: this.failureReason,
    };
  }
}
