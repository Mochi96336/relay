/**
 * Timing alignment measured as three separate, individually unambiguous
 * quantities instead of one ambiguous correlation against the song.
 *
 * ## Why three
 *
 * The mixer reads the captured song at `s` and the microphone at
 * `s + advance`. Write:
 *
 * - `Lmic`     - how much later than it happened the microphone timeline
 *                stores audio (capture buffering, uplink, anchor bias).
 * - `Lbacking` - the same for the captured-song timeline.
 * - `delta`    - the robot's player position minus the phone's. The singer
 *                sings against the *phone's* speaker, so this is a real part
 *                of the offset and it is not zero: the follower only corrects
 *                past a 450 ms dead band.
 *
 * At mixer position `s`, `backing[s]` holds what the robot rendered at real
 * time `s - Lbacking`, which is song position `X(s - Lbacking) + delta`, where
 * `X` is the phone's playback position. `mic[s + advance]` holds what was sung
 * at real time `s + advance - Lmic`, against phone position
 * `X(s + advance - Lmic)`. Setting those equal, and using that `X` advances
 * with real time at rate 1:
 *
 *     s + advance - Lmic = s - Lbacking + delta
 *     advance = Lmic - Lbacking + delta
 *
 * Content correlation measures that whole sum in one go, which is why it works
 * at all - but the song's own beat makes the correlation ambiguous, and every
 * fix for that trades one failure mode for another.
 *
 * ## Why this is unambiguous
 *
 * Each leg is measured against a probe with no self-similar repeat, so its
 * correlation peak is unique by construction. `Lmic` and `Lbacking` are each
 * "where did the probe actually land, against where the session clock says it
 * was played", and `delta` is read directly off the robot's own player.
 *
 * The phone's speaker and the robot's audio never meet in the air - the robot
 * renders into a null sink - so no single probe can cross both paths. That is
 * the fact the earlier one-probe attempt missed: it measured `Lmic` alone and
 * applied it as if it were the whole sum.
 */

export type ProbeLeg = {
  /** Session sample the probe was expected at, from the round-trip estimate. */
  targetSample: number;
  /** Session sample correlation actually found it at. */
  actualSample: number;
  correlation: number;
};

export type BootCalibrationInput = {
  mic: ProbeLeg;
  backing: ProbeLeg;
  /**
   * Robot player position minus the phone's, in milliseconds, as the robot
   * page measures it (`current - target` in its follower).
   */
  deltaMs: number;
  sampleRate: number;
};

export type BootCalibrationResult = {
  /** What `calibratedMicLagMs` should be set to: the mixer's read-ahead. */
  advanceMs: number;
  micLatencyMs: number;
  backingLatencyMs: number;
  deltaMs: number;
  /** The weaker of the two probe correlations - the measurement is only as good. */
  confidence: number;
};

/** How much later than it happened a timeline stores audio, from one probe. */
export function legLatencyMs(leg: ProbeLeg, sampleRate: number) {
  return ((leg.actualSample - leg.targetSample) / sampleRate) * 1000;
}

export function combineBootCalibration(input: BootCalibrationInput): BootCalibrationResult {
  const micLatencyMs = legLatencyMs(input.mic, input.sampleRate);
  const backingLatencyMs = legLatencyMs(input.backing, input.sampleRate);

  return {
    advanceMs: micLatencyMs - backingLatencyMs + input.deltaMs,
    micLatencyMs,
    backingLatencyMs,
    deltaMs: input.deltaMs,
    // A boot calibration is one measurement, not a vote, so it is worth no
    // more than its weakest leg.
    confidence: Math.min(input.mic.correlation, input.backing.correlation),
  };
}
