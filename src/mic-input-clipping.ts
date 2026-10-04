import type { PcmFrame } from './pcm-frame.js';

type SampleRange = {
  start: number;
  end: number;
};

/**
 * Proven raw-input flat-top ranges of the Mic capture, mapped onto the
 * retained Mic session timeline.
 *
 * Detection runs on original source PCM, before sample-rate conversion can
 * blur a flat top. Attribution happens only when the mixer actually reads one
 * of these ranges into an emitted frame, which is why the ranges live in
 * session samples and move with the timeline.
 */
export class MicInputClipping {
  private readonly ranges: SampleRange[] = [];
  private railRunStartSourceSample: number | null = null;
  private railRunSamples = 0;
  /** Whether the current raw rail run has emitted a retained timeline range. */
  private railRunRangeActive = false;

  get empty() {
    return this.ranges.length === 0;
  }

  /** Forgets the raw rail run in progress; ranges already proven stay. */
  resetRun() {
    this.railRunStartSourceSample = null;
    this.railRunSamples = 0;
    this.railRunRangeActive = false;
  }

  clear() {
    this.ranges.length = 0;
    this.resetRun();
  }

  /**
   * Detect raw capture flat tops before resampling can blur them.
   *
   * The browser worklet calls a sample "on the rail" at
   * abs(float) >= 32767/32768. After its asymmetric Float32 -> Int16 mapping
   * that is >= +32766 or <= -32767. Four consecutive source samples match the
   * product-side clipping policy from capture-observability.js.
   *
   * `toSessionSample` maps a source sample index of this capture onto the
   * session timeline as the frame was placed.
   */
  observe(
    frame: PcmFrame,
    toSessionSample: (sourceSample: number) => number,
    minimumSessionSample: number | null,
  ) {
    if (frame.firstSampleIndex === null) return;
    const sourceStart = frame.firstSampleIndex;
    const sampleCount = Math.floor(frame.pcm.byteLength / 2);

    for (let offset = 0; offset < sampleCount; offset += 1) {
      const sample = frame.pcm.readInt16LE(offset * 2);
      const onInputRail = sample >= 32_766 || sample <= -32_767;
      if (!onInputRail) {
        this.resetRun();
        continue;
      }

      const sourceSample = sourceStart + offset;
      if (this.railRunSamples === 0) {
        this.railRunStartSourceSample = sourceSample;
      }
      this.railRunSamples += 1;

      if (
        this.railRunSamples >= 4
        && this.railRunStartSourceSample !== null
      ) {
        const mappedStart = toSessionSample(this.railRunStartSourceSample);
        // A discontinuous/new capture may initially map behind retained old
        // PCM and be overlap-trimmed by ingest(). Its clipping authority starts
        // only where that new capture was actually accepted onto the timeline.
        const start = minimumSessionSample === null
          ? mappedStart
          : Math.max(mappedStart, minimumSessionSample);
        const mappedEnd = toSessionSample(sourceSample + 1);
        // A run proven entirely inside overlap-trimmed old history does
        // not become clipping evidence merely because a later part of the
        // replacement capture was accepted.
        if (minimumSessionSample !== null && mappedEnd <= minimumSessionSample) {
          continue;
        }
        const end = Math.max(start + 1, mappedEnd);

        if (!this.railRunRangeActive) {
          this.ranges.push({ start, end });
          this.railRunRangeActive = true;
        } else {
          const active = this.ranges.at(-1);
          if (active) active.end = Math.max(active.end, end);
        }
      }
    }
  }

  /** First sorted range whose end is strictly after position. */
  private firstRangeAfter(position: number) {
    let low = 0;
    let high = this.ranges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.ranges[mid]!.end <= position) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  at(position: number) {
    const range = this.ranges[this.firstRangeAfter(position)];
    return Boolean(range && range.start <= position && position < range.end);
  }

  /** One flag per sample of the range, or null when nothing is clipped anywhere. */
  mask(startSample: number, count: number) {
    if (count <= 0 || this.ranges.length === 0) return null;
    const mask = new Uint8Array(count);
    const endSample = startSample + count;
    let rangeIndex = this.firstRangeAfter(startSample);

    for (; rangeIndex < this.ranges.length; rangeIndex += 1) {
      const range = this.ranges[rangeIndex]!;
      if (range.start >= endSample) break;
      const start = Math.max(startSample, range.start);
      const end = Math.min(endSample, range.end);
      if (end > start) mask.fill(1, start - startSample, end - startSample);
    }
    return mask;
  }

  /** Drops ranges the retained timeline no longer reaches. */
  trimBefore(beforeSample: number) {
    while (
      this.ranges.length > 0
      && this.ranges[0]!.end <= beforeSample
    ) {
      this.ranges.shift();
    }
    if (
      this.railRunRangeActive
      && this.ranges.length === 0
    ) {
      // The current raw rail run used to own the range that retention just
      // discarded. Keeping only the boolean "active" would leave no range to
      // extend, so later source-contiguous clipped PCM could never become
      // Take evidence again. Restart the proof window at retained history;
      // four fresh rail samples are enough to establish a new bounded range.
      this.resetRun();
    }
  }

  /** Moves every range with the timeline it describes. */
  shift(samples: number) {
    for (const range of this.ranges) {
      range.start += samples;
      range.end += samples;
    }
  }
}
