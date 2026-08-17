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
 * Participant authentication and storage/writer failures stay outside this
 * policy. A voice-only room deliberately ignores unused Robot/backing health;
 * once a Song is loaded, blocked product health makes the room unrecordable.
 */
export function decideTakeStart(facts: TakeStartFacts): TakeStartDecision {
  if (!facts.sessionActive) return { ok: false, reason: 'mix-not-active' };
  if (facts.timingCalibrationActive) {
    return { ok: false, reason: 'timing-calibration-active' };
  }
  if (!facts.songLoaded && !facts.voiceOnlyMicReady) {
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
