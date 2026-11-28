import type { ProbeTarget } from './probe-lifecycle.js';

/**
 * A Mic probe match this strong has always landed where a probe can land: in
 * the 23 results at or above it in the journal from 2026-10-28 to 2026-11-14,
 * every latency was 135-310 ms.
 */
export const PROBE_STRONG_CORRELATION = 0.7;

/**
 * Where a Mic probe can be heard: the page's output and input buffers, the
 * speaker and the air, on top of the timing estimate. Phones and desk mics
 * measured 135-310 ms; Bluetooth adds more.
 */
export const MIC_PROBE_LATENCY_RANGE_MS = Object.freeze({ min: 80, max: 800 });

/**
 * Why a Mic probe match that passed the correlation threshold is still not a
 * measurement, or null when it is.
 *
 * Below the strong correlation the search window (several seconds) holds
 * chance peaks from voice, breath and the song. Below 0.5 only about one
 * result in five fell in a plausible latency, which is what chance gives. On
 * 2026-11-14 two such peaks passed the 0.5 threshold and were applied: 0.584 at
 * 40 ms left one singer 104 ms off for a whole song, and 0.518 at 1485 ms asked
 * for an advance the mix could not give. A weak match therefore also has to land
 * at a latency a probe can have. The Robot leg is a direct capture of the
 * Robot's output, always strongly matched, and is not checked here.
 */
export function implausibleProbeMatch(target: ProbeTarget, correlation: number, latencyMs: number) {
  if (target !== 'mic' || correlation >= PROBE_STRONG_CORRELATION) return null;
  const { min, max } = MIC_PROBE_LATENCY_RANGE_MS;
  if (latencyMs >= min && latencyMs <= max) return null;
  return `weak match (correlation ${correlation.toFixed(3)} below ${PROBE_STRONG_CORRELATION})`
    + ` at implausible latency ${latencyMs.toFixed(0)} ms (outside ${min}-${max} ms)`;
}
