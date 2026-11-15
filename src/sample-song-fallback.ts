export type SongSampleAnchor = {
  videoId: string; generation: number; sampleRate: number; sampleIndex: number;
  mediaSeconds: number; playbackRate: number; state: number; uncertaintyMs: number;
};
type Observation = SongSampleAnchor & { receivedAt: number; agreements: number };

export type FallbackRejection = 'no-mic-anchor' | 'no-backing-anchor' | 'mic-unsettled' | 'backing-unsettled'
  | 'other-song' | 'rate-mismatch' | 'mic-stale' | 'backing-stale' | 'unmapped' | 'out-of-range';

/** Approximate player-to-capture evidence, never acoustic calibration authority. */
export class SampleSongFallback {
  private mic: Observation | null = null;
  private backing: Observation | null = null;
  private calculation: Record<string, unknown> | null = null;
  diagnostics(now: number) {
    return {
      mic: this.mic ? { ...this.mic, ageMs: now - this.mic.receivedAt } : null,
      backing: this.backing ? { ...this.backing, ageMs: now - this.backing.receivedAt } : null,
      calculation: this.calculation,
    };
  }
  observe(side: 'mic' | 'backing', value: SongSampleAnchor, now: number) {
    const previous = this[side];
    if (!/^[\w-]{11}$/.test(value.videoId) || value.state !== 1
      || !Number.isSafeInteger(value.generation) || value.generation < 0
      || !Number.isFinite(value.sampleRate) || value.sampleRate < 8000
      || !Number.isFinite(value.sampleIndex) || value.sampleIndex < 0
      || !Number.isFinite(value.mediaSeconds) || value.mediaSeconds < 0
      || !Number.isFinite(value.playbackRate) || value.playbackRate < .25 || value.playbackRate > 4
      || !Number.isFinite(value.uncertaintyMs) || value.uncertaintyMs < 0 || value.uncertaintyMs > 100) {
      this[side] = null; return false;
    }
    const same = previous && previous.videoId === value.videoId
      && previous.generation === value.generation && previous.sampleRate === value.sampleRate
      && previous.playbackRate === value.playbackRate && now - previous.receivedAt < 1500;
    const span = same ? (value.sampleIndex - previous.sampleIndex) / value.sampleRate : 0;
    const consistent = same && span > 0 && span <= 1.5
      && Math.abs((value.mediaSeconds - previous.mediaSeconds) / value.playbackRate - span) <= .075;
    this[side] = { ...value, receivedAt: now, agreements: consistent ? previous.agreements + 1 : 1 };
    return true;
  }
  /** Why the last estimate gave no candidate; null when it gave one. */
  rejection: FallbackRejection | null = null;
  estimate(now: number, videoId: string, map: (side: 'mic' | 'backing', a: SongSampleAnchor) => number | null, rate: number) {
    this.calculation = null;
    const mic = this.mic, backing = this.backing;
    this.rejection = !mic ? 'no-mic-anchor' : !backing ? 'no-backing-anchor'
      : mic.agreements < 3 ? 'mic-unsettled' : backing.agreements < 3 ? 'backing-unsettled'
      : mic.videoId !== videoId || backing.videoId !== videoId ? 'other-song'
      : mic.playbackRate !== backing.playbackRate ? 'rate-mismatch'
      : now - mic.receivedAt > 1000 ? 'mic-stale' : now - backing.receivedAt > 1000 ? 'backing-stale' : null;
    if (this.rejection || !mic || !backing) return null;
    const m = map('mic', mic), b = map('backing', backing);
    if (m === null || b === null) { this.rejection = 'unmapped'; return null; }
    const advanceMs = (m - b) * 1000 / rate
      + (backing.mediaSeconds - mic.mediaSeconds) * 1000 / mic.playbackRate;
    this.calculation = { observedAtMs: now, mic: { ...mic }, backing: { ...backing },
      sessionSampleRate: rate, micSessionSample: m, backingSessionSample: b,
      sampleDifferenceMs: (m - b) * 1000 / rate,
      songDifferenceMs: (backing.mediaSeconds - mic.mediaSeconds) * 1000 / mic.playbackRate,
      advanceMs, accepted: Number.isFinite(advanceMs) && Math.abs(advanceMs) <= 2000 };
    if (Number.isFinite(advanceMs) && Math.abs(advanceMs) <= 2000) return advanceMs;
    this.rejection = 'out-of-range'; return null;
  }
  clear(side?: 'mic' | 'backing') {
    this.calculation = null;
    this.rejection = null;
    if (side) this[side] = null;
    else { this.mic = null; this.backing = null; }
  }
}

export type FallbackTargetEntry = {
  /** `held` keeps the last sample/song placement; `unplaced` has had none for this song yet. */
  source: 'sample-song' | 'held' | 'unplaced';
  /** Why sample/song gave no candidate. */
  reason: string | null;
  targetMs: number;
};

/**
 * When an uncalibrated singer's fallback target is worth a journal line: its
 * source or the reason for it changed, or it moved this far since the last line.
 * The target is refreshed on every backing packet, so lines for movement alone
 * are at most one per interval.
 */
export class FallbackTargetJournal {
  private last: (FallbackTargetEntry & { atMs: number }) | null = null;
  constructor(private readonly moveMs = 20, private readonly intervalMs = 1000) {}
  note(entry: FallbackTargetEntry, nowMs: number): 'start' | 'source' | 'move' | null {
    const last = this.last;
    const change = !last ? 'start'
      : last.source !== entry.source || last.reason !== entry.reason ? 'source'
      : Math.abs(entry.targetMs - last.targetMs) >= this.moveMs && nowMs - last.atMs >= this.intervalMs ? 'move'
      : null;
    if (change) this.last = { ...entry, atMs: nowMs };
    return change;
  }
  reset() { this.last = null; }
}
