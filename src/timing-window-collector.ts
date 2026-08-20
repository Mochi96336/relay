export type TimingWindow = {
  mic: Int16Array;
  backing: Int16Array;
  originSample: number;
  endSample: number;
  micGapSamples: number;
  backingGapSamples: number;
};

type Capture = {
  chunks: { start: number; samples: Int16Array }[];
  /** Session sample index this side first covered, or null before anything landed. */
  firstStart: number | null;
  /** One past the last index covered. */
  lastEnd: number;
};

function emptyCapture(): Capture {
  return { chunks: [], firstStart: null, lastEnd: 0 };
}

/**
 * Renders one captured side onto a shared session-sample origin.
 *
 * Missing transport data stays zero instead of pulling later audio earlier in
 * time. This is the placement rule content calibration already relies on: a
 * dropout weakens the evidence, but never changes the lag being measured.
 */
function render(capture: Capture, origin: number, total: number) {
  const output = new Int16Array(total);
  let covered = 0;

  for (const { start, samples } of capture.chunks) {
    const offset = start - origin;
    const from = Math.max(0, -offset);
    const at = Math.max(0, offset);
    const length = Math.min(samples.length - from, total - at);
    if (length <= 0) continue;
    output.set(samples.subarray(from, from + length), at);
    covered += length;
  }

  return { samples: output, gapSamples: total - covered };
}

/**
 * Collects fixed-size mic/backing windows on Relay's shared session timeline.
 *
 * This class deliberately knows nothing about calibration confidence, agreement,
 * stale contexts, retries, or the analyser. Its only job is preserving the
 * sample-index semantics shared by initial calibration and background
 * validation: late starts use the first position both sides actually cover,
 * dropped frames remain holes, and already-arrived suffix audio survives when a
 * complete window is consumed.
 */
export class TimingWindowCollector {
  readonly requiredSamples: number;

  private readonly maxBufferedSamples: number;
  private mic = emptyCapture();
  private backing = emptyCapture();

  constructor(requiredSamples: number, maxBufferedSamples = requiredSamples * 2) {
    if (!Number.isSafeInteger(requiredSamples) || requiredSamples <= 0) {
      throw new Error('requiredSamples must be a positive integer.');
    }
    if (!Number.isSafeInteger(maxBufferedSamples) || maxBufferedSamples < requiredSamples) {
      throw new Error('maxBufferedSamples must cover at least one complete window.');
    }
    this.requiredSamples = requiredSamples;
    this.maxBufferedSamples = maxBufferedSamples;
  }

  get progress() {
    return Math.max(0, Math.min(1, this.capturedSamples / this.requiredSamples));
  }

  get ready() {
    return this.capturedSamples >= this.requiredSamples;
  }

  get micSpanSamples() {
    return this.spanSamples(this.mic);
  }

  get backingSpanSamples() {
    return this.spanSamples(this.backing);
  }

  observeMic(samples: Int16Array, startSample: number) {
    this.observe(this.mic, samples, startSample);
  }

  observeBacking(samples: Int16Array, startSample: number) {
    this.observe(this.backing, samples, startSample);
  }

  reset() {
    this.mic = emptyCapture();
    this.backing = emptyCapture();
  }

  /**
   * Returns and consumes one ready window, retaining any suffix already buffered
   * beyond that window for the next independent measurement.
   */
  takeReadyWindow(): TimingWindow | null {
    if (!this.ready) return null;

    const originSample = this.origin ?? 0;
    const endSample = originSample + this.requiredSamples;
    const mic = render(this.mic, originSample, this.requiredSamples);
    const backing = render(this.backing, originSample, this.requiredSamples);

    this.mic = this.retainAfter(this.mic, endSample);
    this.backing = this.retainAfter(this.backing, endSample);

    return {
      mic: mic.samples,
      backing: backing.samples,
      originSample,
      endSample,
      micGapSamples: mic.gapSamples,
      backingGapSamples: backing.gapSamples,
    };
  }

  /** The first session position both sides have actually reached. */
  private get origin() {
    if (this.mic.firstStart === null || this.backing.firstStart === null) return null;
    return Math.max(this.mic.firstStart, this.backing.firstStart);
  }

  /** How much contiguous timeline span both sides now reach from the shared origin. */
  private get capturedSamples() {
    const origin = this.origin;
    if (origin === null) return 0;
    return Math.max(0, Math.min(this.mic.lastEnd, this.backing.lastEnd) - origin);
  }

  private observe(capture: Capture, samples: Int16Array, startSample: number) {
    if (samples.length === 0) return;
    if (!Number.isSafeInteger(startSample) || startSample < 0) {
      throw new Error('startSample must be a non-negative integer.');
    }

    // Preserve the existing collector's bounded-buffer rule: once one side has
    // run too far ahead, later chunks are ignored until the slower side catches
    // up. A large chunk whose start is still in range remains intact so a burst
    // can legitimately contain more than one complete window.
    if (
      capture.firstStart !== null
      && startSample - capture.firstStart >= this.maxBufferedSamples
    ) return;

    if (capture.firstStart === null) capture.firstStart = startSample;
    capture.chunks.push({ start: startSample, samples });
    capture.lastEnd = Math.max(capture.lastEnd, startSample + samples.length);
  }

  private retainAfter(capture: Capture, beforeSample: number) {
    const retained = emptyCapture();

    for (const chunk of capture.chunks) {
      const chunkEnd = chunk.start + chunk.samples.length;
      if (chunkEnd <= beforeSample) continue;

      const offset = Math.max(0, beforeSample - chunk.start);
      const start = chunk.start + offset;
      const samples = chunk.samples.subarray(offset);
      if (samples.length === 0) continue;

      if (retained.firstStart === null) retained.firstStart = start;
      retained.chunks.push({ start, samples });
      retained.lastEnd = Math.max(retained.lastEnd, start + samples.length);
    }

    return retained;
  }

  private spanSamples(capture: Capture) {
    if (capture.firstStart === null) return 0;
    return Math.max(0, capture.lastEnd - capture.firstStart);
  }
}
