import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';

/** A blocked event loop at least this long is logged. */
export const EVENT_LOOP_STALL_MS = 150;

export type EventLoopStallRecord = {
  maxDelayMs: number;
  p99DelayMs: number;
  windowMs: number;
};

/**
 * Whether one window of event-loop delay is worth a log line.
 *
 * Every socket read, the mixer tick and Mic packet intake share this one
 * thread, so a pause here looks, from the page's side, exactly like the
 * network holding audio back: a second with too little Mic followed by a
 * second with too much. Logging the pause is what separates the two.
 */
export function eventLoopStall(
  histogram: Pick<IntervalHistogram, 'max' | 'percentile'>,
  windowMs: number,
  thresholdMs = EVENT_LOOP_STALL_MS,
): EventLoopStallRecord | null {
  const maxDelayMs = histogram.max / 1e6;
  if (!Number.isFinite(maxDelayMs) || maxDelayMs < thresholdMs) return null;
  return {
    maxDelayMs: Math.round(maxDelayMs),
    p99DelayMs: Math.round(histogram.percentile(99) / 1e6),
    windowMs,
  };
}

/** Samples event-loop delay and logs each window that held a stall. Returns a stop function. */
export function watchEventLoopStalls(
  log: (record: EventLoopStallRecord) => void,
  { windowMs = 1_000, thresholdMs = EVENT_LOOP_STALL_MS } = {},
) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    const record = eventLoopStall(histogram, windowMs, thresholdMs);
    histogram.reset();
    if (record) log(record);
  }, windowMs);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    histogram.disable();
  };
}
