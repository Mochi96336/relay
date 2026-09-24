/**
 * Diagnostic-only watch on whether a Mic the room calls live is actually
 * reaching the mix.
 *
 * `micPlayable` fails only after a *consecutive* unplayable run, so an
 * intermittent pattern - 60 ms missing out of every 100 ms - never trips it
 * while the vocal is effectively gone. Neither does a capture that keeps
 * delivering PCM made entirely of digital zeros, which a real microphone never
 * produces: its noise floor always moves at least one LSB. This monitor scores
 * fixed windows of emitted frames for exactly those shapes and reports episode
 * edges. It owns no authority and changes no audio; product state stays with
 * the owners in ARCHITECTURE_BOUNDARIES.md.
 */

export type MicAudibilityKind =
  /** Received PCM covers too little of the window: uplink loss. */
  | 'uplink-underfed'
  /** Emitted frames read gap/frontier instead of Mic PCM. */
  | 'mix-unplayable'
  /** Every received sample was exactly zero. */
  | 'digital-silence';

export const MIC_AUDIBILITY_KINDS: readonly MicAudibilityKind[] = [
  'uplink-underfed',
  'mix-unplayable',
  'digital-silence',
];

export type MicAudibilityFrame = {
  /** The same live answer the room's Mic state is built from. */
  micLive: boolean;
  frameSamples: number;
  micGapSamples: number;
  micStarvedSamples: number;
};

export type MicAudibilityWindow = {
  windowSamples: number;
  liveSamples: number;
  receivedSamples: number;
  nonZeroReceivedSamples: number;
  missingSamples: number;
  receivedFraction: number;
  missingFraction: number;
  receivedRmsDbfs: number | null;
};

export type MicAudibilityEvent = {
  edge: 'start' | 'continue' | 'end';
  kind: MicAudibilityKind;
  /** Windows this episode has lasted, including the current one. */
  windows: number;
  durationMs: number;
};

export type MicAudibilityResult = {
  window: MicAudibilityWindow;
  eligible: boolean;
  suspect: MicAudibilityKind[];
  events: MicAudibilityEvent[];
};

export type MicAudibilityMonitorOptions = {
  sampleRate: number;
  windowMs?: number;
  /** Missing (or not received) share of a live window that counts as suspect. */
  suspectFraction?: number;
  /** Re-report an ongoing episode every this many windows. */
  repeatEveryWindows?: number;
  /** Consecutive suspect windows before the Mic is called degraded. */
  degradedAfterWindows?: number;
  /** Consecutive clean windows before a degraded Mic is called healthy again. */
  recoveredAfterWindows?: number;
};

const SILENCE_DBFS = -120;

export class MicAudibilityMonitor {
  readonly sampleRate: number;
  readonly windowSamples: number;
  readonly windowMs: number;
  readonly suspectFraction: number;
  readonly repeatEveryWindows: number;
  readonly degradedAfterWindows: number;
  readonly recoveredAfterWindows: number;

  private emittedSamples = 0;
  private liveSamples = 0;
  private missingSamples = 0;
  private receivedSamples = 0;
  private nonZeroReceivedSamples = 0;
  private receivedSquareSum = 0;
  private readonly episodes = new Map<MicAudibilityKind, number>();
  private lastWindow: MicAudibilityWindow | null = null;
  private degradedState = false;
  private suspectRunWindows = 0;
  private cleanRunWindows = 0;

  constructor(options: MicAudibilityMonitorOptions) {
    const windowMs = options.windowMs ?? 1_000;
    const suspectFraction = options.suspectFraction ?? 0.2;
    const repeatEveryWindows = options.repeatEveryWindows ?? 5;
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
      throw new RangeError('sampleRate must be positive');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be positive');
    }
    if (!Number.isFinite(suspectFraction) || suspectFraction <= 0 || suspectFraction >= 1) {
      throw new RangeError('suspectFraction must be in (0, 1)');
    }
    if (!Number.isInteger(repeatEveryWindows) || repeatEveryWindows < 1) {
      throw new RangeError('repeatEveryWindows must be a positive integer');
    }
    this.sampleRate = options.sampleRate;
    this.windowMs = windowMs;
    this.windowSamples = Math.max(1, Math.round((windowMs * options.sampleRate) / 1000));
    this.suspectFraction = suspectFraction;
    this.repeatEveryWindows = repeatEveryWindows;
    this.degradedAfterWindows = options.degradedAfterWindows ?? 2;
    this.recoveredAfterWindows = options.recoveredAfterWindows ?? 3;
    if (!Number.isInteger(this.degradedAfterWindows) || this.degradedAfterWindows < 1) {
      throw new RangeError('degradedAfterWindows must be a positive integer');
    }
    if (!Number.isInteger(this.recoveredAfterWindows) || this.recoveredAfterWindows < 1) {
      throw new RangeError('recoveredAfterWindows must be a positive integer');
    }
  }

  /**
   * Whether a live Mic has been failing to reach the mix for a sustained
   * stretch. Raised after consecutive suspect windows and lowered only after
   * consecutive clean ones, so one bad second never flickers product state.
   * A window the room did not call live resets it: the Mic state owns that.
   */
  get degraded() {
    return this.degradedState;
  }

  /** Mic PCM the mixer accepted onto its timeline, at the mix rate. */
  observeReceived(samples: Int16Array) {
    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (sample !== 0) this.nonZeroReceivedSamples += 1;
      this.receivedSquareSum += sample * sample;
    }
    this.receivedSamples += samples.length;
  }

  /** One emitted mix frame. Returns a result each time a window closes. */
  observeFrame(frame: MicAudibilityFrame): MicAudibilityResult | null {
    this.emittedSamples += frame.frameSamples;
    if (frame.micLive) {
      this.liveSamples += frame.frameSamples;
      this.missingSamples += Math.min(
        frame.frameSamples,
        frame.micGapSamples + frame.micStarvedSamples,
      );
    }
    if (this.emittedSamples < this.windowSamples) return null;
    return this.closeWindow();
  }

  /** The last closed window and every open episode, for diagnostics surfaces. */
  status() {
    return {
      degraded: this.degradedState,
      lastWindow: this.lastWindow,
      activeEpisodes: [...this.episodes].map(([kind, windows]) => ({
        kind,
        windows,
        durationMs: windows * this.windowMs,
      })),
    };
  }

  /** Ends every open episode, for example when the capture is replaced. */
  reset(): MicAudibilityEvent[] {
    const events = this.endEpisodes(new Set());
    this.clearWindow();
    this.degradedState = false;
    this.suspectRunWindows = 0;
    this.cleanRunWindows = 0;
    return events;
  }

  private closeWindow(): MicAudibilityResult {
    const windowSamples = this.emittedSamples;
    const rms = this.receivedSamples > 0
      ? Math.sqrt(this.receivedSquareSum / this.receivedSamples) / 0x8000
      : 0;
    const window: MicAudibilityWindow = {
      windowSamples,
      liveSamples: this.liveSamples,
      receivedSamples: this.receivedSamples,
      nonZeroReceivedSamples: this.nonZeroReceivedSamples,
      missingSamples: this.missingSamples,
      receivedFraction: this.receivedSamples / windowSamples,
      missingFraction: this.liveSamples > 0 ? this.missingSamples / this.liveSamples : 0,
      receivedRmsDbfs: this.receivedSamples > 0
        ? (rms > 0 ? 20 * Math.log10(rms) : SILENCE_DBFS)
        : null,
    };
    this.clearWindow();
    this.lastWindow = window;

    // Only a window the room called live for its whole length says anything
    // about a silent failure. Edges of a Mic session are ordinary startup and
    // teardown, not a vocal the UI claims is there.
    const eligible = window.liveSamples >= windowSamples;
    const suspect: MicAudibilityKind[] = [];
    if (eligible) {
      if (window.receivedFraction < 1 - this.suspectFraction) suspect.push('uplink-underfed');
      if (window.missingFraction >= this.suspectFraction) suspect.push('mix-unplayable');
      if (window.receivedSamples > 0 && window.nonZeroReceivedSamples === 0) {
        suspect.push('digital-silence');
      }
    }

    if (!eligible) {
      this.degradedState = false;
      this.suspectRunWindows = 0;
      this.cleanRunWindows = 0;
    } else if (suspect.length > 0) {
      this.suspectRunWindows += 1;
      this.cleanRunWindows = 0;
      if (this.suspectRunWindows >= this.degradedAfterWindows) this.degradedState = true;
    } else {
      this.cleanRunWindows += 1;
      this.suspectRunWindows = 0;
      if (this.cleanRunWindows >= this.recoveredAfterWindows) this.degradedState = false;
    }

    const active = new Set(suspect);
    const events = this.endEpisodes(active);
    for (const kind of suspect) {
      const windows = (this.episodes.get(kind) ?? 0) + 1;
      this.episodes.set(kind, windows);
      if (windows === 1 || (windows - 1) % this.repeatEveryWindows === 0) {
        events.push({
          edge: windows === 1 ? 'start' : 'continue',
          kind,
          windows,
          durationMs: windows * this.windowMs,
        });
      }
    }
    return { window, eligible, suspect, events };
  }

  private endEpisodes(active: Set<MicAudibilityKind>) {
    const events: MicAudibilityEvent[] = [];
    for (const kind of MIC_AUDIBILITY_KINDS) {
      const windows = this.episodes.get(kind);
      if (windows === undefined || active.has(kind)) continue;
      this.episodes.delete(kind);
      events.push({ edge: 'end', kind, windows, durationMs: windows * this.windowMs });
    }
    return events;
  }

  private clearWindow() {
    this.emittedSamples = 0;
    this.liveSamples = 0;
    this.missingSamples = 0;
    this.receivedSamples = 0;
    this.nonZeroReceivedSamples = 0;
    this.receivedSquareSum = 0;
  }
}
