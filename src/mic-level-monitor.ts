/**
 * Whether a live Mic's gain leaves the voice usable in the room mix.
 *
 * Two opposite failures, judged on different evidence:
 *
 * - Too loud is what the limiter actually did. `limitedSamples` counts any
 *   reduction past 0.1 dB, and its peak-hold envelope keeps a single transient
 *   "limited" for hundreds of milliseconds, so it reads near 100% for a singer
 *   the limiter is barely touching. Only a reduction deep enough to hear
 *   (`heavyLimitedSamples`) says the gain is too high.
 * - Too quiet is the raw capture peak plus the current gain. The raw peak does
 *   not depend on the gain, so a gain change re-judges the same history at once
 *   instead of waiting for the singer to prove the new setting.
 *
 * Level alone cannot tell a quiet singer from one who is not singing. Too quiet
 * is therefore judged only while the song plays and only over a long run, and
 * its copy is conditional. An instrumental longer than that run can still raise
 * it; that is accepted.
 *
 * Diagnostic evidence only: this owns no authority and changes no audio.
 */

export type MicLevelWarning = 'too-loud' | 'too-quiet';

export type MicLevelFrame = {
  /** The same live answer the room's Mic state is built from. */
  micLive: boolean;
  frameSamples: number;
  /** Emitted Mic samples the limiter held down by more than the heavy depth. */
  heavyLimitedSamples: number;
};

/** Room facts read once per window, from the owners that hold them. */
export type MicLevelContext = {
  songPlaying: boolean;
  micGainDb: number;
};

export type MicLevelWindow = {
  eligible: boolean;
  songPlaying: boolean;
  heavyLimitedMs: number;
  /** Raw capture peak, before Relay gain. Null when nothing arrived. */
  rawPeakDbfs: number | null;
  micGainDb: number;
};

export type MicLevelMonitorOptions = {
  sampleRate: number;
  windowMs?: number;
  /** Heavy limiting inside one window that makes it count as hot. */
  hotHeavyLimitedMs?: number;
  /** Recent windows too loud is judged over. */
  loudWindows?: number;
  /** Hot windows among `loudWindows` that raise too loud. */
  loudHotWindows?: number;
  /** Consecutive cool windows that clear too loud. */
  loudClearWindows?: number;
  /** Consecutive quiet windows that raise too quiet. */
  quietWindows?: number;
  /** Post-gain peak every one of `quietWindows` must stay under. */
  quietOnDbfs?: number;
  /** Post-gain peak any window must reach to clear too quiet. */
  quietClearDbfs?: number;
};

const SILENCE_DBFS = -120;

export class MicLevelMonitor {
  readonly sampleRate: number;
  readonly windowMs: number;
  readonly windowSamples: number;
  readonly hotHeavyLimitedSamples: number;
  readonly loudWindows: number;
  readonly loudHotWindows: number;
  readonly loudClearWindows: number;
  readonly quietWindows: number;
  readonly quietOnDbfs: number;
  readonly quietClearDbfs: number;

  private emittedSamples = 0;
  private liveSamples = 0;
  private heavyLimitedSamples = 0;
  private receivedSamples = 0;
  private rawPeak = 0;

  private loud = false;
  private hotHistory: boolean[] = [];
  private coolRunWindows = 0;
  private quiet = false;
  /** Raw peaks of consecutive eligible windows while the song plays, newest last. */
  private quietPeaksDbfs: number[] = [];
  private lastWindow: MicLevelWindow | null = null;

  constructor(options: MicLevelMonitorOptions) {
    const windowMs = options.windowMs ?? 1_000;
    if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
      throw new RangeError('sampleRate must be positive');
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new RangeError('windowMs must be positive');
    }
    this.sampleRate = options.sampleRate;
    this.windowMs = windowMs;
    this.windowSamples = Math.max(1, Math.round((windowMs * options.sampleRate) / 1000));
    this.hotHeavyLimitedSamples = Math.round(
      ((options.hotHeavyLimitedMs ?? 100) * options.sampleRate) / 1000,
    );
    this.loudWindows = options.loudWindows ?? 5;
    this.loudHotWindows = options.loudHotWindows ?? 3;
    this.loudClearWindows = options.loudClearWindows ?? 10;
    this.quietWindows = options.quietWindows ?? 15;
    this.quietOnDbfs = options.quietOnDbfs ?? -30;
    this.quietClearDbfs = options.quietClearDbfs ?? -24;
    for (const [name, value] of [
      ['loudWindows', this.loudWindows],
      ['loudHotWindows', this.loudHotWindows],
      ['loudClearWindows', this.loudClearWindows],
      ['quietWindows', this.quietWindows],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer`);
      }
    }
    if (this.loudHotWindows > this.loudWindows) {
      throw new RangeError('loudHotWindows cannot exceed loudWindows');
    }
    if (!(this.quietClearDbfs >= this.quietOnDbfs)) {
      throw new RangeError('quietClearDbfs must not be below quietOnDbfs');
    }
  }

  /** Too loud wins: both at once would need a peak above and below the limits. */
  get warning(): MicLevelWarning | null {
    if (this.loud) return 'too-loud';
    if (this.quiet) return 'too-quiet';
    return null;
  }

  /** Mic PCM the mixer accepted onto its timeline, before Relay gain. */
  observeReceived(samples: Int16Array) {
    let peak = this.rawPeak;
    for (let i = 0; i < samples.length; i += 1) {
      const magnitude = Math.abs(samples[i]);
      if (magnitude > peak) peak = magnitude;
    }
    this.rawPeak = peak;
    this.receivedSamples += samples.length;
  }

  /**
   * One emitted mix frame. `context` is read only when a window closes.
   * Returns true when the warning changed.
   */
  observeFrame(frame: MicLevelFrame, context: () => MicLevelContext): boolean {
    this.emittedSamples += frame.frameSamples;
    if (frame.micLive) {
      this.liveSamples += frame.frameSamples;
      this.heavyLimitedSamples += frame.heavyLimitedSamples;
    }
    if (this.emittedSamples < this.windowSamples) return false;
    return this.closeWindow(context());
  }

  /**
   * The singer moved the gain. Lowering it invalidates the limiter history,
   * which was measured at the old gain; too quiet is re-judged against the raw
   * peaks already seen. Returns true when the warning changed.
   */
  noteMicGainChanged(previousDb: number, nextDb: number): boolean {
    if (nextDb === previousDb) return false;
    const before = this.warning;
    if (nextDb < previousDb) this.clearLoud();
    this.judgeQuiet(nextDb);
    return this.warning !== before;
  }

  status() {
    return {
      warning: this.warning,
      hotWindows: this.hotHistory.filter(Boolean).length,
      /**
       * While too loud, consecutive windows the limiter left alone, and how many
       * clear the warning. The warning outlives any single calm second, so a
       * reader needs both to explain a warning beside a quiet last window.
       */
      calmWindows: this.loud ? this.coolRunWindows : 0,
      calmWindowsNeeded: this.loudClearWindows,
      quietRunWindows: this.quietPeaksDbfs.length,
      lastWindow: this.lastWindow,
    };
  }

  /** Forgets everything, for example when the capture is replaced. */
  reset() {
    this.clearWindow();
    this.clearLoud();
    this.clearQuiet();
    this.lastWindow = null;
  }

  private closeWindow({ songPlaying, micGainDb }: MicLevelContext) {
    const before = this.warning;
    const eligible = this.liveSamples >= this.windowSamples;
    const rawPeakDbfs = this.receivedSamples > 0
      ? (this.rawPeak > 0 ? 20 * Math.log10(this.rawPeak / 0x8000) : SILENCE_DBFS)
      : null;
    const hot = this.heavyLimitedSamples >= this.hotHeavyLimitedSamples;
    this.lastWindow = {
      eligible,
      songPlaying,
      heavyLimitedMs: (this.heavyLimitedSamples / this.sampleRate) * 1000,
      rawPeakDbfs,
      micGainDb,
    };
    this.clearWindow();

    // A window the room did not call live for its whole length is Mic startup,
    // teardown or a handoff. The Mic state owns those; start over after them.
    if (!eligible) {
      this.clearLoud();
      this.clearQuiet();
      return this.warning !== before;
    }

    this.hotHistory.push(hot);
    if (this.hotHistory.length > this.loudWindows) this.hotHistory.shift();
    if (this.loud) {
      this.coolRunWindows = hot ? 0 : this.coolRunWindows + 1;
      if (this.coolRunWindows >= this.loudClearWindows) this.clearLoud();
    } else if (this.hotHistory.filter(Boolean).length >= this.loudHotWindows) {
      this.loud = true;
      this.coolRunWindows = 0;
    }

    if (songPlaying && rawPeakDbfs !== null) {
      this.quietPeaksDbfs.push(rawPeakDbfs);
      if (this.quietPeaksDbfs.length > this.quietWindows) this.quietPeaksDbfs.shift();
      this.judgeQuiet(micGainDb);
    } else {
      this.clearQuiet();
    }
    return this.warning !== before;
  }

  private judgeQuiet(micGainDb: number) {
    if (this.quietPeaksDbfs.length === 0) return;
    const loudestDbfs = Math.max(...this.quietPeaksDbfs) + micGainDb;
    if (this.quiet) {
      if (loudestDbfs >= this.quietClearDbfs) this.quiet = false;
    } else if (
      this.quietPeaksDbfs.length >= this.quietWindows
      && loudestDbfs < this.quietOnDbfs
    ) {
      this.quiet = true;
    }
  }

  private clearLoud() {
    this.loud = false;
    this.hotHistory = [];
    this.coolRunWindows = 0;
  }

  private clearQuiet() {
    this.quiet = false;
    this.quietPeaksDbfs = [];
  }

  private clearWindow() {
    this.emittedSamples = 0;
    this.liveSamples = 0;
    this.heavyLimitedSamples = 0;
    this.receivedSamples = 0;
    this.rawPeak = 0;
  }
}
