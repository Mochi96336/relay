import { decideBootProbeAnalysisEvidence } from './boot-probe-analysis-evidence-policy.js';
import { mediaToWallMs } from './boot-calibration.js';
import { MAX_CAPTURE_GAP_MS } from './calibration-session.js';
import { locateProbe, PROBE_REFERENCE_MS } from './calibration-probe.js';
import { probeScheduleTime, sanitizeProbeTimingDiagnostics } from './probe-timing-diagnostics.js';

/**
 * The second singer's test tone: the main Mic's boot probe, for B.
 *
 * The Mic's boot probe plays the same three notes at one server-chosen moment
 * on the phone and on the Robot. The phone's notes travel speaker → Mic →
 * timeline exactly as the song does on its way to the singer and back as their
 * voice; the Robot's travel exactly as the backing does. Where each lands, one
 * minus the other, is the Mic's advance.
 *
 * The Robot's leg does not depend on who sings, so B reuses the one the boot
 * probe measured and plays only its own: B's advance = B's Mic path − backing
 * path + the Robot player's offset, the boot calibration's own formula.
 *
 * Once per B capture. B is silent in the room output while the notes are out,
 * so the room never hears B's test tone.
 */

export type DuetProbeState = 'idle' | 'requested' | 'analyzing' | 'measured' | 'failed';

export type DuetProbeOptions = {
  sampleRate: number;
  leadMs: number;
  searchMarginMs: number;
  minCorrelation: number;
  replyTimeoutMs: number;
  analysisTimeoutMs: number;
  /** Sends the request to B's page; false when it could not be sent. */
  send: (request: { requestId: number; leadMs: number }) => boolean;
  sessionSampleAt: (atMs: number) => number;
  totalSamples: () => number;
  generation: () => number | null;
  read: (start: number, count: number) => Int16Array;
  evidence: (start: number, count: number) => { gapSamples: number; frontierMissingSamples: number } | null;
};

type Analysis = { targetSample: number; windowStart: number; windowSamples: number; deadlineMs: number };

export class DuetProbe {
  state: DuetProbeState = 'idle';
  failureReason: string | null = null;
  /** B's Mic path: where its notes landed after the moment they were due. */
  micLatencyMs: number | null = null;
  correlation: number | null = null;
  private captureKey: string | null = null;
  private requestId = 0;
  private generation: number | null = null;
  private sentAtMs = 0;
  private analysis: Analysis | null = null;

  constructor(private readonly options: DuetProbeOptions) {}

  /** B's notes are out or being looked for: keep B out of the room output. */
  get silencing() {
    return this.state === 'requested' || this.state === 'analyzing';
  }

  /**
   * Starts the one probe for this B capture. A capture already probed (or
   * failed) is not probed again.
   */
  begin(captureKey: string, nowMs: number) {
    if (captureKey === this.captureKey) return false;
    const generation = this.options.generation();
    if (generation === null) return false;
    this.captureKey = captureKey;
    this.state = 'requested';
    this.failureReason = null;
    this.micLatencyMs = null;
    this.correlation = null;
    this.analysis = null;
    this.generation = generation;
    this.requestId += 1;
    this.sentAtMs = nowMs;
    if (!this.options.send({ requestId: this.requestId, leadMs: this.options.leadMs })) {
      this.fail('request could not be sent');
    }
    return true;
  }

  played(reply: { requestId: unknown; generation: unknown; timingDiagnostics?: unknown }, nowMs: number) {
    if (this.state !== 'requested' || reply.requestId !== this.requestId) return false;
    if (Number(reply.generation) !== this.generation) {
      this.fail('B capture changed');
      return false;
    }
    const client = sanitizeProbeTimingDiagnostics(reply.timingDiagnostics);
    const schedule = probeScheduleTime(this.sentAtMs, nowMs, this.options.leadMs, client);
    const { sampleRate, searchMarginMs } = this.options;
    const targetSample = Math.round(this.options.sessionSampleAt(schedule.targetAtMs));
    const marginSamples = Math.round((sampleRate * searchMarginMs) / 1000);
    const referenceSamples = Math.round((sampleRate * PROBE_REFERENCE_MS) / 1000);
    this.analysis = {
      targetSample,
      windowStart: targetSample - Math.round(marginSamples / 8),
      windowSamples: referenceSamples + marginSamples,
      deadlineMs: nowMs + this.options.analysisTimeoutMs,
    };
    this.state = 'analyzing';
    return true;
  }

  clientFailed(reply: { requestId: unknown; reason?: unknown }) {
    if (this.state !== 'requested' || reply.requestId !== this.requestId) return false;
    const reason = typeof reply.reason === 'string' ? reply.reason.slice(0, 200) : 'B could not play the probe';
    this.fail(`B page: ${reason}`);
    return true;
  }

  tick(nowMs: number) {
    if (this.state === 'requested' && nowMs - this.sentAtMs > this.options.replyTimeoutMs) {
      this.fail('B page did not answer');
      return;
    }
    const analysis = this.analysis;
    if (this.state !== 'analyzing' || !analysis) return;
    if (this.options.generation() !== this.generation) {
      this.fail('B capture changed');
      return;
    }
    const needed = analysis.windowStart + analysis.windowSamples;
    if (this.options.totalSamples() < needed) {
      if (nowMs > analysis.deadlineMs) this.fail("B's audio did not reach the analyzer in time");
      return;
    }
    const evidence = this.options.evidence(analysis.windowStart, analysis.windowSamples);
    if (!evidence) {
      this.fail('B left');
      return;
    }
    const decision = decideBootProbeAnalysisEvidence({
      gapSamples: evidence.gapSamples,
      frontierMissingSamples: evidence.frontierMissingSamples,
      sampleRate: this.options.sampleRate,
      maxGapMs: MAX_CAPTURE_GAP_MS,
    });
    if (decision.kind === 'reject') {
      this.fail(`B's audio had a ${Math.round(decision.gapMs)} ms gap`);
      return;
    }
    const window = this.options.read(analysis.windowStart, analysis.windowSamples);
    const { offsetSamples, correlation } = locateProbe(window, this.options.sampleRate);
    this.correlation = correlation;
    if (correlation < this.options.minCorrelation) {
      // With headphones the notes never reach B's Mic; trying again would not either.
      this.fail('not heard (headphones?)');
      return;
    }
    const actualSample = analysis.windowStart + offsetSamples;
    this.micLatencyMs = ((actualSample - analysis.targetSample) / this.options.sampleRate) * 1000;
    this.analysis = null;
    this.state = 'measured';
  }

  /** B's advance against the backing path the boot probe measured; null until both exist. */
  advanceMs(backingLatencyMs: number | null, deltaMs: number, playbackRate: number) {
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

  private fail(reason: string) {
    this.state = 'failed';
    this.failureReason = reason;
    this.analysis = null;
  }
}
