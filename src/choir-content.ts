import { Worker } from 'node:worker_threads';

import { MAX_CAPTURE_GAP_MS } from './calibration-session.js';
import { TimingWindowCollector, type TimingWindow } from './timing-window-collector.js';

/**
 * Content measurement for the second singer, on the room output's own
 * timeline.
 *
 * Both singers are already `MicTrack`s of the one `AudioSession`, so their
 * PCM and the Robot backing arrive on the same session sample coordinate.
 * Each singer is correlated against that backing on its own (A's window,
 * then B's), and B is placed by the difference: B's advance = A's advance +
 * (B's lag − A's lag). The difference holds whatever the backing's own
 * offset is, because both lags are measured against the same backing; so
 * the backing is observed at its raw room position, with no song mapping.
 *
 * A measurement belongs to one epoch. A capture restart of either singer or a
 * new song invalidates the difference (`hard`). A pause, resume or seek only
 * asks for a fresh measurement: the singers' devices did not change, so the
 * last difference keeps placing B meanwhile (`soft`), rather than handing B
 * back to a cruder estimate and jumping it twice.
 */

export const CHOIR_CONTENT_WINDOW_SECONDS = 6;
const RETRY_DELAY_MS = 2_500;
const MAX_RETRY_DELAY_MS = 6_000;
/** A singer's lag past this is a failed correlation, not a voice. */
const MAX_LAG_MS = 2_800;

export type ChoirContentAnalysis = { micLagMs: number; confidence: number };
export type ChoirContentAnalyzer = (mic: Int16Array, backing: Int16Array) => Promise<ChoirContentAnalysis>;

type Singer = 'primary' | 'secondary';

export class ChoirContent {
  private readonly collectors: Record<Singer, TimingWindowCollector>;
  private readonly lags: Record<Singer, number | null> = { primary: null, secondary: null };
  /** The last measured difference, kept across a soft reset until re-measured. */
  private heldOffsetMs: number | null = null;
  private readonly maxGapSamples: number;
  private epoch = 0;
  private inFlight = false;
  private next: Singer = 'primary';
  private nextAttemptAtMs = 0;
  private failureStreak = 0;
  readonly stats = { submitted: 0, applied: 0, rejected: 0 };
  lastFailureReason: string | null = null;
  lastResetReason: string | null = null;

  constructor(private readonly options: {
    sampleRate: number;
    minConfidence: number;
    analyze: ChoirContentAnalyzer;
  }) {
    const windowSamples = CHOIR_CONTENT_WINDOW_SECONDS * options.sampleRate;
    this.collectors = {
      primary: new TimingWindowCollector(windowSamples),
      secondary: new TimingWindowCollector(windowSamples),
    };
    this.maxGapSamples = Math.round((options.sampleRate * MAX_CAPTURE_GAP_MS) / 1000);
  }

  observePrimary(samples: Int16Array, start: number) {
    this.collectors.primary.observeMic(samples, start);
  }

  observeSecondary(samples: Int16Array, start: number) {
    this.collectors.secondary.observeMic(samples, start);
  }

  observeBacking(samples: Int16Array, start: number) {
    this.collectors.primary.observeBacking(samples, start);
    this.collectors.secondary.observeBacking(samples, start);
  }

  /**
   * Starts a new measurement epoch. `hard`: the difference no longer holds
   * (a capture restart, a new song). Otherwise the last difference is held
   * until the new epoch measures both singers.
   */
  reset(reason: string, { hard = false }: { hard?: boolean } = {}) {
    const offset = this.secondaryOffsetMs;
    this.heldOffsetMs = hard ? null : offset;
    this.epoch += 1;
    this.collectors.primary.reset();
    this.collectors.secondary.reset();
    this.lags.primary = null;
    this.lags.secondary = null;
    this.failureStreak = 0;
    this.nextAttemptAtMs = 0;
    this.lastResetReason = reason;
  }

  /** B's lag relative to A: this epoch's, once both are measured, else the one held. */
  get secondaryOffsetMs() {
    const { primary, secondary } = this.lags;
    return primary === null || secondary === null ? this.heldOffsetMs : secondary - primary;
  }

  status() {
    return {
      epoch: this.epoch,
      primaryLagMs: this.lags.primary,
      secondaryLagMs: this.lags.secondary,
      heldOffsetMs: this.heldOffsetMs,
      inFlight: this.inFlight,
      ...this.stats,
      lastFailureReason: this.lastFailureReason,
      lastResetReason: this.lastResetReason,
    };
  }

  /**
   * Starts at most one analysis. Alternates singers so neither waits behind
   * the other; a singer whose window is not ready yields its turn.
   */
  tick(nowMs: number) {
    if (this.inFlight || nowMs < this.nextAttemptAtMs) return false;
    for (const singer of [this.next, this.other(this.next)]) {
      const window = this.collectors[singer].takeReadyWindow();
      if (!window) continue;
      this.next = this.other(singer);
      if (!this.usable(window)) {
        this.reject('window-gaps', nowMs);
        return false;
      }
      this.submit(singer, window, nowMs);
      return true;
    }
    return false;
  }

  private other(singer: Singer): Singer {
    return singer === 'primary' ? 'secondary' : 'primary';
  }

  private usable(window: TimingWindow) {
    return window.micGapSamples <= this.maxGapSamples && window.backingGapSamples <= this.maxGapSamples;
  }

  private submit(singer: Singer, window: TimingWindow, nowMs: number) {
    const epoch = this.epoch;
    this.inFlight = true;
    this.stats.submitted += 1;
    this.options.analyze(window.mic, window.backing).then((result) => {
      this.inFlight = false;
      if (epoch !== this.epoch) return;
      if (!Number.isFinite(result.micLagMs) || Math.abs(result.micLagMs) > MAX_LAG_MS) {
        this.reject('invalid-lag', nowMs);
      } else if (!Number.isFinite(result.confidence) || result.confidence < this.options.minConfidence) {
        this.reject('low-confidence', nowMs);
      } else {
        this.lags[singer] = result.micLagMs;
        this.stats.applied += 1;
        this.failureStreak = 0;
        this.lastFailureReason = null;
      }
    }, (error: unknown) => {
      this.inFlight = false;
      if (epoch !== this.epoch) return;
      this.reject(`analyzer: ${error instanceof Error ? error.message : String(error)}`, nowMs);
    });
  }

  private reject(reason: string, nowMs: number) {
    this.stats.rejected += 1;
    this.lastFailureReason = reason;
    this.failureStreak += 1;
    this.nextAttemptAtMs = nowMs + Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * this.failureStreak);
  }
}

/**
 * The production analyzer: the six-second FFT correlation runs in one worker
 * thread, never on the 5 ms mixer tick. One job at a time (ChoirContent never
 * overlaps them), each bounded by a timeout that replaces a stuck worker.
 */
export function createChoirContentWorkerAnalyzer(sampleRate: number, timeoutMs = 2_000): ChoirContentAnalyzer {
  let worker: Worker | null = null;
  let nextId = 1;
  const spawn = () => {
    const created = new Worker(new URL('./choir-content-analysis-worker.mjs', import.meta.url), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 24 },
    });
    created.unref();
    return created;
  };
  return (mic, backing) => new Promise((resolve, reject) => {
    const active = worker ??= spawn();
    const id = nextId++;
    const done = () => {
      clearTimeout(timeout);
      active.off('message', onMessage);
      active.off('error', onError);
      active.off('exit', onExit);
    };
    const retire = () => {
      if (worker === active) worker = null;
      void active.terminate();
    };
    const onMessage = (reply: { id: number; ok: boolean; micLagMs?: number; confidence?: number; reason?: string }) => {
      if (reply?.id !== id) return;
      done();
      if (reply.ok) resolve({ micLagMs: Number(reply.micLagMs), confidence: Number(reply.confidence) });
      else reject(new Error(reply.reason ?? 'analysis failed'));
    };
    const onError = (error: Error) => { done(); retire(); reject(error); };
    const onExit = (code: number) => { done(); if (worker === active) worker = null; reject(new Error(`worker-exit: ${code}`)); };
    const timeout = setTimeout(() => { done(); retire(); reject(new Error('timeout')); }, timeoutMs);
    timeout.unref?.();
    active.on('message', onMessage);
    active.on('error', onError);
    active.on('exit', onExit);
    try {
      active.postMessage({ id, sampleRate, mic, backing }, [mic.buffer as ArrayBuffer, backing.buffer as ArrayBuffer]);
    } catch (error) {
      done();
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
