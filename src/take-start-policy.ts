import type { TakeLifecycle } from './take-session.js';

export type TakeStartBlockReason =
  | 'mix-not-active'
  | 'timing-calibration-active'
  | 'take-not-ready'
  | 'take-active';

export type TakeStartFacts = {
  sessionActive: boolean;
  timingCalibrationActive: boolean;
  songLoaded: boolean;
  /** Historical name; this now means current Mic media is live for every Take. */
  voiceOnlyMicReady: boolean;
  roomBlocked: boolean;
  takeLifecycle: TakeLifecycle;
};

export type TakeStartDecision =
  | { ok: true }
  | { ok: false; reason: TakeStartBlockReason };

/**
 * Owns the room-level decision for whether a new Take may start.
 *
 * Relay's current product defines a Take as a singing performance. There is no
 * explicit backing-only recording mode, so both voice-only and Song Takes need
 * current live Mic media. A voice-only room may still ignore unused
 * Robot/backing health; once a Song is loaded, blocked product health is an
 * additional reason the room is not recordable.
 */
export function decideTakeStart(facts: TakeStartFacts): TakeStartDecision {
  if (!facts.sessionActive) return { ok: false, reason: 'mix-not-active' };
  if (facts.timingCalibrationActive) {
    return { ok: false, reason: 'timing-calibration-active' };
  }
  if (!facts.voiceOnlyMicReady) {
    return { ok: false, reason: 'take-not-ready' };
  }
  if (facts.songLoaded && facts.roomBlocked) {
    return { ok: false, reason: 'take-not-ready' };
  }
  if (facts.takeLifecycle === 'recording' || facts.takeLifecycle === 'finalizing') {
    return { ok: false, reason: 'take-active' };
  }
  return { ok: true };
}
