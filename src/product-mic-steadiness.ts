import { SteadyFlag } from './steady-flag.js';

/** What product status reads about the Mic, before and after it is held steady. */
export type ProductMicFacts = {
  /** The capture these facts are about; a new one starts over. */
  capture: number | null;
  flowObserved: boolean;
  /** Playable in the live mix. */
  streaming: boolean;
  audibilityDegraded: boolean;
  inTransit: boolean;
};

/**
 * Holds the Mic facts product status reads, so its warnings neither flicker
 * nor give stale advice. Readiness, calibration and /statusz keep the raw facts.
 *
 * - A problem is raised after 1 s and cleared after 2 s. On 2026-10-09, 17% of
 *   the good stretches between Mic dropouts lasted 2 s or less; 3 s held more of
 *   them but kept the warning up 3 s after every recovery.
 * - Audio in transit is held as long as the problem it explains, so a warning
 *   still up after the audio caught up does not switch to "retry Mic".
 * - A capture whose audio arrives but has not been playable yet is starting, not
 *   interrupted, for a 3 s grace: the startup gap flashed "retry Mic" at every
 *   Mic start. Holding it from the start instead kept the Mic from reading live,
 *   and so a voice-only Take from starting, for seconds after it was playable.
 */
export class ProductMicSteadiness {
  static readonly STARTUP_GRACE_MS = 3_000;

  private readonly unplayable = new SteadyFlag({ raiseMs: 1_000, clearMs: 2_000 });
  private readonly audibilityDegraded = new SteadyFlag({ raiseMs: 1_000, clearMs: 2_000 });
  private readonly inTransit = new SteadyFlag({ raiseMs: 0, clearMs: 2_000 });
  private capture: number | null = null;
  private seenPlayable = false;
  private flowSinceMs: number | null = null;

  observe(raw: ProductMicFacts, nowMs: number): ProductMicFacts {
    if (raw.capture !== this.capture) {
      this.capture = raw.capture;
      this.seenPlayable = false;
      this.flowSinceMs = null;
      this.unplayable.reset();
      this.audibilityDegraded.reset();
      this.inTransit.reset();
    }
    if (raw.streaming) this.seenPlayable = true;
    if (raw.flowObserved && this.flowSinceMs === null) this.flowSinceMs = nowMs;
    const starting = raw.flowObserved
      && !this.seenPlayable
      && nowMs - (this.flowSinceMs ?? nowMs) < ProductMicSteadiness.STARTUP_GRACE_MS;

    return {
      capture: raw.capture,
      flowObserved: raw.flowObserved && !starting,
      streaming: this.seenPlayable ? !this.unplayable.update(!raw.streaming, nowMs) : raw.streaming,
      audibilityDegraded: this.seenPlayable
        ? this.audibilityDegraded.update(raw.audibilityDegraded, nowMs)
        : raw.audibilityDegraded,
      inTransit: this.inTransit.update(raw.inTransit, nowMs),
    };
  }
}
