export type SongSampleAnchor = {
  videoId: string; generation: number; sampleRate: number; sampleIndex: number;
  mediaSeconds: number; playbackRate: number; state: number; uncertaintyMs: number;
};
type Observation = SongSampleAnchor & { receivedAt: number; agreements: number };

/** Approximate player-to-capture evidence, never acoustic calibration authority. */
export class SampleSongFallback {
  private mic: Observation | null = null;
  private backing: Observation | null = null;
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
  estimate(now: number, videoId: string, map: (side: 'mic' | 'backing', a: SongSampleAnchor) => number | null, rate: number) {
    const mic = this.mic, backing = this.backing;
    if (!mic || !backing || mic.agreements < 3 || backing.agreements < 3
      || mic.videoId !== videoId || backing.videoId !== videoId
      || mic.playbackRate !== backing.playbackRate
      || now - mic.receivedAt > 1000 || now - backing.receivedAt > 1000) return null;
    const m = map('mic', mic), b = map('backing', backing);
    if (m === null || b === null) return null;
    const advanceMs = (m - b) * 1000 / rate
      + (backing.mediaSeconds - mic.mediaSeconds) * 1000 / mic.playbackRate;
    return Number.isFinite(advanceMs) && Math.abs(advanceMs) <= 2000 ? advanceMs : null;
  }
  clear(side?: 'mic' | 'backing') {
    if (side) this[side] = null;
    else { this.mic = null; this.backing = null; }
  }
}
