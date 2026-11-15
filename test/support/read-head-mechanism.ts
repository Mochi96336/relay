import type { AudioSessionOptions } from '../../src/audio-session.js';

/**
 * The read-head rates these mechanism tests were written at: 1% walks, a
 * 100 ms frontier prompt release, and jumps at once. What they pin - how a walk
 * interpolates, what a crossfade blends, what evidence each frame carries -
 * does not depend on the live rates, which audio-session-read-head-policy pins.
 */
export const READ_HEAD_MECHANISM: Partial<AudioSessionOptions> = {
  micWalkFraction: 0.01,
  micJumpQuietWaitMs: 0,
  micWalkLimitMs: Number.POSITIVE_INFINITY,
};
